#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>

// Relates the DeckLink audio sample clock to the server's system clock.
//
// A DeckLink callback is delivered after the audio packet was captured and its
// scheduling delay is not constant.  We therefore keep the lowest-latency
// observation in each one-second bucket and fit a rolling linear model.  The
// slope tracks the small difference between the SDI audio clock and the server
// clock; the intercept tracks the absolute server time.
class ServerClockMapper {
public:
    explicit ServerClockMapper(std::uint32_t nominalSampleRate,
                               std::int64_t calibrationSeconds = 5,
                               std::int64_t windowSeconds = 30 * 60)
        : sampleRate_(nominalSampleRate),
          nominalNanosecondsPerFrame_(
              1'000'000'000.0L / static_cast<long double>(nominalSampleRate)),
          calibrationFrames_(calibrationSeconds * nominalSampleRate),
          windowFrames_(windowSeconds * nominalSampleRate) {}

    // packetFrame is the first frame in the packet. capturedAt is sampled in
    // the callback after GetBytes(), so packet duration is subtracted before
    // adding the observation.
    void observe(std::int64_t packetFrame,
                 std::uint32_t packetFrames,
                 std::chrono::system_clock::time_point capturedAt) {
        const std::int64_t capturedNs = toNanoseconds(capturedAt);
        const std::int64_t packetDurationNs = static_cast<std::int64_t>(
            std::llround(static_cast<long double>(packetFrames) *
                         nominalNanosecondsPerFrame_));
        const std::int64_t observedStartNs = capturedNs - packetDurationNs;

        if (!initialized_) {
            initialize(packetFrame, observedStartNs);
        } else if (ready_) {
            const std::int64_t predicted = mapFrameNanoseconds(packetFrame);
            // A large system-clock step or DeckLink clock reset must not be
            // diluted through the 30-minute regression window.
            if (std::llabs(observedStartNs - predicted) > 500'000'000LL) {
                reset();
                initialize(packetFrame, observedStartNs);
            }
        }

        const std::int64_t x = packetFrame - baseFrame_;
        const long double nominal =
            static_cast<long double>(baseWallNanoseconds_) +
            static_cast<long double>(x) * nominalNanosecondsPerFrame_;
        const long double residual =
            static_cast<long double>(observedStartNs) - nominal;
        const std::int64_t bucket = x / static_cast<std::int64_t>(sampleRate_);

        if (!bucketActive_) {
            bucketActive_ = true;
            bucketIndex_ = bucket;
            bucketFrame_ = x;
            bucketResidual_ = residual;
        } else if (bucket == bucketIndex_) {
            if (residual < bucketResidual_) {
                bucketFrame_ = x;
                bucketResidual_ = residual;
            }
        } else {
            commitBucket();
            bucketIndex_ = bucket;
            bucketFrame_ = x;
            bucketResidual_ = residual;
        }

        latestFrame_ = packetFrame + static_cast<std::int64_t>(packetFrames);
        updateModel();
    }

    bool ready() const {
        return ready_;
    }

    std::size_t observationCount() const {
        return observations_.size() + (bucketActive_ ? 1U : 0U);
    }

    std::chrono::system_clock::time_point mapFrame(
        std::int64_t frame) const {
        return std::chrono::system_clock::time_point{
            std::chrono::nanoseconds{mapFrameNanoseconds(frame)}};
    }

    std::int64_t frameAt(
        std::chrono::system_clock::time_point time) const {
        const long double ns = static_cast<long double>(toNanoseconds(time));
        const long double base =
            static_cast<long double>(baseWallNanoseconds_) + interceptNs_;
        const long double frames =
            static_cast<long double>(baseFrame_) +
            (ns - base) / nanosecondsPerFrame();
        return static_cast<std::int64_t>(std::ceil(frames));
    }

    double estimatedSampleRate() const {
        return static_cast<double>(1'000'000'000.0L / nanosecondsPerFrame());
    }

private:
    struct Observation {
        std::int64_t frame = 0;  // Relative to baseFrame_.
        long double residualNs = 0.0L;
    };

    static std::int64_t toNanoseconds(
        std::chrono::system_clock::time_point time) {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
                   time.time_since_epoch()).count();
    }

    void initialize(std::int64_t frame, std::int64_t wallNanoseconds) {
        initialized_ = true;
        baseFrame_ = frame;
        latestFrame_ = frame;
        baseWallNanoseconds_ = wallNanoseconds;
        interceptNs_ = 0.0L;
        slopeCorrectionNsPerFrame_ = 0.0L;
    }

    void reset() {
        initialized_ = false;
        ready_ = false;
        observations_.clear();
        bucketActive_ = false;
        interceptNs_ = 0.0L;
        slopeCorrectionNsPerFrame_ = 0.0L;
    }

    void commitBucket() {
        if (!bucketActive_) return;
        observations_.push_back({bucketFrame_, bucketResidual_});
        const std::int64_t newest = observations_.back().frame;
        while (!observations_.empty() &&
               newest - observations_.front().frame > windowFrames_) {
            observations_.pop_front();
        }
    }

    void updateModel() {
        if (!initialized_) return;
        ready_ = latestFrame_ - baseFrame_ >= calibrationFrames_ &&
                 observationCount() >= 4;

        // Include the current bucket in the fit without permanently committing
        // it. Long double keeps epoch-scale timestamps out of the regression.
        const std::size_t count = observationCount();
        if (count == 0) return;
        long double sx = 0.0L;
        long double sy = 0.0L;
        long double sxx = 0.0L;
        long double sxy = 0.0L;
        auto add = [&](std::int64_t frame, long double residual) {
            const long double x = static_cast<long double>(frame);
            sx += x;
            sy += residual;
            sxx += x * x;
            sxy += x * residual;
        };
        for (const auto& observation : observations_) {
            add(observation.frame, observation.residualNs);
        }
        if (bucketActive_) add(bucketFrame_, bucketResidual_);

        long double slope = 0.0L;
        if (count >= 120) {
            const long double n = static_cast<long double>(count);
            const long double denominator = n * sxx - sx * sx;
            if (std::fabs(denominator) > 1.0L) {
                slope = (n * sxy - sx * sy) / denominator;
            }
            // Reject impossible estimates caused by callback stalls. This is
            // ±1000 ppm, much wider than normal SDI/server clock differences.
            const long double limit = nominalNanosecondsPerFrame_ * 0.001L;
            slope = std::max(-limit, std::min(limit, slope));
        }

        // Use the smallest fitted residual as the intercept. Callback latency
        // can only make an observation later, never earlier.
        long double intercept = std::numeric_limits<long double>::max();
        auto consider = [&](std::int64_t frame, long double residual) {
            intercept = std::min(
                intercept,
                residual - slope * static_cast<long double>(frame));
        };
        for (const auto& observation : observations_) {
            consider(observation.frame, observation.residualNs);
        }
        if (bucketActive_) consider(bucketFrame_, bucketResidual_);
        if (intercept != std::numeric_limits<long double>::max()) {
            interceptNs_ = intercept;
            slopeCorrectionNsPerFrame_ = slope;
        }
    }

    long double nanosecondsPerFrame() const {
        return nominalNanosecondsPerFrame_ + slopeCorrectionNsPerFrame_;
    }

    std::int64_t mapFrameNanoseconds(std::int64_t frame) const {
        const long double value =
            static_cast<long double>(baseWallNanoseconds_) + interceptNs_ +
            static_cast<long double>(frame - baseFrame_) *
                nanosecondsPerFrame();
        return static_cast<std::int64_t>(std::llround(value));
    }

    std::uint32_t sampleRate_;
    long double nominalNanosecondsPerFrame_;
    std::int64_t calibrationFrames_;
    std::int64_t windowFrames_;
    bool initialized_ = false;
    bool ready_ = false;
    std::int64_t baseFrame_ = 0;
    std::int64_t latestFrame_ = 0;
    std::int64_t baseWallNanoseconds_ = 0;
    std::deque<Observation> observations_;
    bool bucketActive_ = false;
    std::int64_t bucketIndex_ = 0;
    std::int64_t bucketFrame_ = 0;
    long double bucketResidual_ = 0.0L;
    long double interceptNs_ = 0.0L;
    long double slopeCorrectionNsPerFrame_ = 0.0L;
};
