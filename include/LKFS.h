#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <stdexcept>
#include <vector>

namespace loudness {

// A header-only stereo BS.1770/EBU R128 loudness calculator.
//
// PCM is K-weighted continuously. The filter state is deliberately preserved
// between calls; resetting it for each 400 ms window produces incorrect
// momentary and integrated loudness values.
//
// This class is not thread-safe. Feed it from one ordered audio stream.
class LKFS {
public:
    enum class FilterType {
        // Matches pyloudnorm.Meter(rate)'s default K-weighting filters.
        Rbj,
        // Matches pyloudnorm.Meter(rate, filter_class="DeMan") and the
        // coefficients given by ITU-R BS.1770 at 48 kHz.
        DeMan,
    };

    static constexpr std::uint32_t kSampleRate = 48000;
    static constexpr std::uint16_t kChannels = 2;
    static constexpr std::uint32_t kWindowSamples = 19200;  // 400 ms
    static constexpr std::uint32_t kHopSamples = 4800;      // 100 ms, 75% overlap
    static constexpr double kCalibrationOffset = -0.691;
    static constexpr double kAbsoluteGateLKFS = -70.0;

    struct MomentaryBlock {
        // Zero-based positions in the PCM stream passed to this instance.
        // endSample is exclusive.
        std::uint64_t startSample = 0;
        std::uint64_t endSample = 0;

        // Ungated 400 ms loudness. Silence is represented by -infinity.
        double mlkfs = -std::numeric_limits<double>::infinity();
    };

    explicit LKFS(FilterType filterType = FilterType::Rbj,
                  std::uint32_t blockGridOffsetSamples = 0)
        : energyWindow_(kWindowSamples, 0.0),
          filterType_(filterType),
          blockGridOffsetSamples_(
              validateBlockGridOffset(blockGridOffsetSamples)),
          leftFilter_(makeKWeightingFilter(filterType)),
          rightFilter_(makeKWeightingFilter(filterType)) {}

    // Clears the K-weighting filter state, rolling window and sample clock.
    // Do this only when starting a genuinely new PCM stream, not at every WAV
    // boundary and not for every programme/integration interval.
    void reset() noexcept {
        leftFilter_.reset();
        rightFilter_.reset();
        std::fill(energyWindow_.begin(), energyWindow_.end(), 0.0);
        energyWritePosition_ = 0;
        samplesInWindow_ = 0;
        totalSamples_ = 0;
        windowEnergySum_ = 0.0;
        windowEnergyCompensation_ = 0.0;
    }

    std::uint64_t processedSampleFrames() const noexcept { return totalSamples_; }
    FilterType filterType() const noexcept { return filterType_; }
    std::uint32_t blockGridOffsetSamples() const noexcept {
        return blockGridOffsetSamples_;
    }

    // Processes DeckLink-style, interleaved signed 32-bit stereo PCM.
    // The returned vector contains zero or more new 400 ms blocks. Calls may
    // contain any positive number of sample frames.
    std::vector<MomentaryBlock> processInterleavedInt32(
        const std::int32_t* pcm,
        std::size_t sampleFrames,
        std::size_t inputChannels = kChannels) {
        if (pcm == nullptr && sampleFrames != 0) {
            throw std::invalid_argument("PCM pointer is null");
        }
        if (inputChannels < kChannels) {
            throw std::invalid_argument("PCM must contain at least two channels");
        }

        std::vector<MomentaryBlock> result;
        result.reserve(sampleFrames / kHopSamples + 1);
        constexpr double kInt32Scale = 1.0 / 2147483648.0;

        for (std::size_t frame = 0; frame < sampleFrames; ++frame) {
            const double left =
                static_cast<double>(pcm[frame * inputChannels]) * kInt32Scale;
            const double right =
                static_cast<double>(pcm[frame * inputChannels + 1]) * kInt32Scale;
            processNormalizedFrame(left, right, result);
        }
        return result;
    }

    // Same PCM format as processInterleavedInt32(), but safe for byte buffers
    // whose address is not guaranteed to be aligned for std::int32_t.
    std::vector<MomentaryBlock> processInterleavedInt32Bytes(
        const void* pcm,
        std::size_t sampleFrames,
        std::size_t inputChannels = kChannels) {
        if (pcm == nullptr && sampleFrames != 0) {
            throw std::invalid_argument("PCM pointer is null");
        }
        if (inputChannels < kChannels) {
            throw std::invalid_argument("PCM must contain at least two channels");
        }

        const auto* bytes = static_cast<const std::uint8_t*>(pcm);
        const std::size_t frameBytes = inputChannels * sizeof(std::int32_t);
        std::vector<MomentaryBlock> result;
        result.reserve(sampleFrames / kHopSamples + 1);
        constexpr double kInt32Scale = 1.0 / 2147483648.0;
        for (std::size_t frame = 0; frame < sampleFrames; ++frame) {
            std::int32_t leftSample = 0;
            std::int32_t rightSample = 0;
            std::memcpy(&leftSample, bytes + frame * frameBytes,
                        sizeof(leftSample));
            std::memcpy(&rightSample,
                        bytes + frame * frameBytes + sizeof(leftSample),
                        sizeof(rightSample));
            processNormalizedFrame(static_cast<double>(leftSample) * kInt32Scale,
                                   static_cast<double>(rightSample) * kInt32Scale,
                                   result);
        }
        return result;
    }

    std::vector<MomentaryBlock> processInterleavedInt16(
        const std::int16_t* pcm,
        std::size_t sampleFrames,
        std::size_t inputChannels = kChannels) {
        if (pcm == nullptr && sampleFrames != 0) {
            throw std::invalid_argument("PCM pointer is null");
        }
        if (inputChannels < kChannels) {
            throw std::invalid_argument("PCM must contain at least two channels");
        }

        std::vector<MomentaryBlock> result;
        result.reserve(sampleFrames / kHopSamples + 1);
        constexpr double kInt16Scale = 1.0 / 32768.0;
        for (std::size_t frame = 0; frame < sampleFrames; ++frame) {
            const double left =
                static_cast<double>(pcm[frame * inputChannels]) * kInt16Scale;
            const double right =
                static_cast<double>(pcm[frame * inputChannels + 1]) * kInt16Scale;
            processNormalizedFrame(left, right, result);
        }
        return result;
    }

    std::vector<MomentaryBlock> processInterleavedInt16Bytes(
        const void* pcm,
        std::size_t sampleFrames,
        std::size_t inputChannels = kChannels) {
        if (pcm == nullptr && sampleFrames != 0) {
            throw std::invalid_argument("PCM pointer is null");
        }
        if (inputChannels < kChannels) {
            throw std::invalid_argument("PCM must contain at least two channels");
        }

        const auto* bytes = static_cast<const std::uint8_t*>(pcm);
        const std::size_t frameBytes = inputChannels * sizeof(std::int16_t);
        std::vector<MomentaryBlock> result;
        result.reserve(sampleFrames / kHopSamples + 1);
        constexpr double kInt16Scale = 1.0 / 32768.0;
        for (std::size_t frame = 0; frame < sampleFrames; ++frame) {
            std::int16_t leftSample = 0;
            std::int16_t rightSample = 0;
            std::memcpy(&leftSample, bytes + frame * frameBytes,
                        sizeof(leftSample));
            std::memcpy(&rightSample,
                        bytes + frame * frameBytes + sizeof(leftSample),
                        sizeof(rightSample));
            processNormalizedFrame(static_cast<double>(leftSample) * kInt16Scale,
                                   static_cast<double>(rightSample) * kInt16Scale,
                                   result);
        }
        return result;
    }

    // Useful for decoded WAV data or another normalized PCM source.
    // Samples are expected in the conventional [-1.0, 1.0) range.
    std::vector<MomentaryBlock> processInterleavedDouble(
        const double* pcm,
        std::size_t sampleFrames,
        std::size_t inputChannels = kChannels) {
        if (pcm == nullptr && sampleFrames != 0) {
            throw std::invalid_argument("PCM pointer is null");
        }
        if (inputChannels < kChannels) {
            throw std::invalid_argument("PCM must contain at least two channels");
        }

        std::vector<MomentaryBlock> result;
        result.reserve(sampleFrames / kHopSamples + 1);
        for (std::size_t frame = 0; frame < sampleFrames; ++frame) {
            processNormalizedFrame(pcm[frame * inputChannels],
                                   pcm[frame * inputChannels + 1], result);
        }
        return result;
    }

    // Reconstructs gated Integrated Loudness from ungated M-LKFS blocks.
    // nullopt means that no block passed the absolute silence gate.
    static std::optional<double> integratedLoudness(
        const std::vector<double>& momentaries) {
        std::vector<EnergyBlock> blocks;
        blocks.reserve(momentaries.size());

        for (double value : momentaries) {
            if (std::isnan(value)) {
                continue;
            }
            const double energy = loudnessToEnergy(value);
            if (std::isfinite(energy) && energy >= 0.0) {
                blocks.push_back({value, energy});
            }
        }
        return integratedFromEnergyBlocks(blocks);
    }

    static std::optional<double> integratedLoudness(
        const std::vector<MomentaryBlock>& momentaries) {
        std::vector<double> values;
        values.reserve(momentaries.size());
        for (const MomentaryBlock& block : momentaries) {
            values.push_back(block.mlkfs);
        }
        return integratedLoudness(values);
    }

    // Computes I-LKFS for a programme/segment using only complete 400 ms
    // blocks contained in [startSample, endSample). An incomplete block at
    // either boundary is discarded as required by EBU Tech 3341.
    static std::optional<double> integratedLoudness(
        const std::vector<MomentaryBlock>& momentaries,
        std::uint64_t startSample,
        std::uint64_t endSample) {
        if (endSample < startSample) {
            throw std::invalid_argument("endSample precedes startSample");
        }
        std::vector<double> values;
        for (const MomentaryBlock& block : momentaries) {
            if (block.startSample >= startSample && block.endSample <= endSample) {
                values.push_back(block.mlkfs);
            }
        }
        return integratedLoudness(values);
    }

    static double loudnessToEnergy(double lkfs) noexcept {
        if (lkfs == -std::numeric_limits<double>::infinity()) {
            return 0.0;
        }
        return std::pow(10.0, (lkfs - kCalibrationOffset) / 10.0);
    }

    static double energyToLoudness(double energy) noexcept {
        if (!(energy > 0.0)) {
            return -std::numeric_limits<double>::infinity();
        }
        return kCalibrationOffset + 10.0 * std::log10(energy);
    }

private:
    class Biquad {
    public:
        Biquad(double b0, double b1, double b2, double a1, double a2)
            : b0_(b0), b1_(b1), b2_(b2), a1_(a1), a2_(a2) {}

        double process(double input) noexcept {
            // Transposed direct form II keeps only two state values and is
            // well suited to continuous sample-by-sample processing.
            const double output = b0_ * input + state1_;
            state1_ = b1_ * input - a1_ * output + state2_;
            state2_ = b2_ * input - a2_ * output;
            return output;
        }

        void reset() noexcept {
            state1_ = 0.0;
            state2_ = 0.0;
        }

    private:
        double b0_;
        double b1_;
        double b2_;
        double a1_;
        double a2_;
        double state1_ = 0.0;
        double state2_ = 0.0;
    };

    class KWeightingFilter {
    public:
        KWeightingFilter(Biquad shelf, Biquad highPass)
            : shelf_(shelf), highPass_(highPass) {}

        double process(double input) noexcept {
            return highPass_.process(shelf_.process(input));
        }

        void reset() noexcept {
            shelf_.reset();
            highPass_.reset();
        }

    private:
        Biquad shelf_;
        Biquad highPass_;
    };

    struct EnergyBlock {
        double loudness;
        double energy;
    };

    static std::uint32_t validateBlockGridOffset(std::uint32_t offset) {
        if (offset >= kHopSamples) {
            throw std::invalid_argument(
                "Loudness block grid offset must be less than 100 ms");
        }
        return offset;
    }

    static KWeightingFilter makeKWeightingFilter(FilterType filterType) {
        if (filterType == FilterType::Rbj) {
            return makeRbjKWeightingFilter();
        }
        return makeDeManKWeightingFilter();
    }

    static KWeightingFilter makeRbjKWeightingFilter() {
        // pyloudnorm's default K-weighting filter:
        //   high shelf: G=4 dB, Q=1/sqrt(2), fc=1500 Hz
        //   high pass:  G=0 dB, Q=0.5,       fc=38 Hz
        constexpr double kPi = 3.14159265358979323846;

        const double shelfGain = 4.0;
        const double shelfQ = 1.0 / std::sqrt(2.0);
        const double shelfFrequency = 1500.0;
        const double shelfA = std::pow(10.0, shelfGain / 40.0);
        const double shelfW0 = 2.0 * kPi * shelfFrequency / kSampleRate;
        const double shelfAlpha = std::sin(shelfW0) / (2.0 * shelfQ);
        const double shelfCos = std::cos(shelfW0);
        const double shelfSqrtA = std::sqrt(shelfA);
        const double shelfA0 =
            (shelfA + 1.0) - (shelfA - 1.0) * shelfCos +
            2.0 * shelfSqrtA * shelfAlpha;
        Biquad shelf(
            shelfA * ((shelfA + 1.0) + (shelfA - 1.0) * shelfCos +
                      2.0 * shelfSqrtA * shelfAlpha) / shelfA0,
            -2.0 * shelfA * ((shelfA - 1.0) +
                             (shelfA + 1.0) * shelfCos) / shelfA0,
            shelfA * ((shelfA + 1.0) + (shelfA - 1.0) * shelfCos -
                      2.0 * shelfSqrtA * shelfAlpha) / shelfA0,
            2.0 * ((shelfA - 1.0) - (shelfA + 1.0) * shelfCos) / shelfA0,
            ((shelfA + 1.0) - (shelfA - 1.0) * shelfCos -
             2.0 * shelfSqrtA * shelfAlpha) / shelfA0);

        const double highPassQ = 0.5;
        const double highPassFrequency = 38.0;
        const double highPassW0 = 2.0 * kPi * highPassFrequency / kSampleRate;
        const double highPassAlpha =
            std::sin(highPassW0) / (2.0 * highPassQ);
        const double highPassCos = std::cos(highPassW0);
        const double highPassA0 = 1.0 + highPassAlpha;
        Biquad highPass(
            (1.0 + highPassCos) / (2.0 * highPassA0),
            -(1.0 + highPassCos) / highPassA0,
            (1.0 + highPassCos) / (2.0 * highPassA0),
            -2.0 * highPassCos / highPassA0,
            (1.0 - highPassAlpha) / highPassA0);

        return KWeightingFilter(shelf, highPass);
    }

    static KWeightingFilter makeDeManKWeightingFilter() {
        // ITU-R BS.1770 K-weighting coefficients for 48 kHz.
        Biquad shelf(1.5351248595864504,
                     -2.691696189405335,
                     1.1983928108523243,
                     -1.6906592931824103,
                     0.7324807742158501);
        Biquad highPass(1.0,
                        -2.0,
                        1.0,
                        -1.9900474548339802,
                        0.9900722503662102);
        return KWeightingFilter(shelf, highPass);
    }

    void processNormalizedFrame(double left,
                                double right,
                                std::vector<MomentaryBlock>& result) {
        if (!std::isfinite(left) || !std::isfinite(right)) {
            throw std::invalid_argument("PCM contains a non-finite sample");
        }

        const double filteredLeft = leftFilter_.process(left);
        const double filteredRight = rightFilter_.process(right);
        const double energy = filteredLeft * filteredLeft +
                              filteredRight * filteredRight;

        double replacedEnergy = 0.0;
        if (samplesInWindow_ == kWindowSamples) {
            replacedEnergy = energyWindow_[energyWritePosition_];
        } else {
            ++samplesInWindow_;
        }
        energyWindow_[energyWritePosition_] = energy;
        addCompensated(energy - replacedEnergy,
                       windowEnergySum_, windowEnergyCompensation_);
        energyWritePosition_ = (energyWritePosition_ + 1) % kWindowSamples;
        ++totalSamples_;

        if (samplesInWindow_ == kWindowSamples) {
            const std::uint64_t blockStart = totalSamples_ - kWindowSamples;
            if (blockStart < blockGridOffsetSamples_ ||
                (blockStart - blockGridOffsetSamples_) % kHopSamples != 0) {
                return;
            }
            // Clamp a tiny negative sum caused solely by floating-point
            // subtraction after a very long run.
            const double meanEnergy =
                std::max(0.0, windowEnergySum_ / kWindowSamples);
            result.push_back({blockStart,
                              totalSamples_,
                              energyToLoudness(meanEnergy)});
        }
    }

    static std::optional<double> integratedFromEnergyBlocks(
        const std::vector<EnergyBlock>& blocks) {
        double absoluteEnergySum = 0.0;
        double absoluteEnergyCompensation = 0.0;
        std::size_t absoluteCount = 0;
        for (const EnergyBlock& block : blocks) {
            if (block.loudness >= kAbsoluteGateLKFS) {
                addCompensated(block.energy, absoluteEnergySum,
                               absoluteEnergyCompensation);
                ++absoluteCount;
            }
        }
        if (absoluteCount == 0) {
            return std::nullopt;
        }

        const double absoluteGatedLoudness = energyToLoudness(
            absoluteEnergySum / static_cast<double>(absoluteCount));
        const double relativeGate = absoluteGatedLoudness - 10.0;

        double gatedEnergySum = 0.0;
        double gatedEnergyCompensation = 0.0;
        std::size_t gatedCount = 0;
        for (const EnergyBlock& block : blocks) {
            if (block.loudness > kAbsoluteGateLKFS &&
                block.loudness > relativeGate) {
                addCompensated(block.energy, gatedEnergySum,
                               gatedEnergyCompensation);
                ++gatedCount;
            }
        }
        if (gatedCount == 0) {
            return std::nullopt;
        }

        return energyToLoudness(gatedEnergySum /
                                static_cast<double>(gatedCount));
    }

    static void addCompensated(double value,
                               double& sum,
                               double& compensation) noexcept {
        const double corrected = value - compensation;
        const double updated = sum + corrected;
        compensation = (updated - sum) - corrected;
        sum = updated;
    }

    std::vector<double> energyWindow_;
    std::size_t energyWritePosition_ = 0;
    std::uint32_t samplesInWindow_ = 0;
    std::uint64_t totalSamples_ = 0;
    double windowEnergySum_ = 0.0;
    double windowEnergyCompensation_ = 0.0;
    const FilterType filterType_;
    const std::uint32_t blockGridOffsetSamples_;
    KWeightingFilter leftFilter_;
    KWeightingFilter rightFilter_;
};

}  // namespace loudness
