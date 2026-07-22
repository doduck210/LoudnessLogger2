#include "WavSegmentWriter.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>

namespace {

constexpr std::uint64_t kMaxWaveDataBytes =
    static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max()) - 36U;
constexpr std::int64_t kSeoulUtcOffsetSeconds = 9LL * 60LL * 60LL;

void writeLe16(std::ostream& output, std::uint16_t value) {
    const std::array<char, 2> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
    };
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void writeLe32(std::ostream& output, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU),
    };
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

std::tm seoulTime(std::time_t utcTime) {
    const std::time_t shiftedTime = utcTime + kSeoulUtcOffsetSeconds;
    std::tm result{};
    gmtime_r(&shiftedTime, &result);
    return result;
}

std::string timestampForFilename(std::chrono::system_clock::time_point time) {
    const std::time_t raw = std::chrono::system_clock::to_time_t(time);
    const std::tm seoul = seoulTime(raw);
    std::ostringstream output;
    output << std::put_time(&seoul, "%Y-%m-%d_%H.%M.%S");
    return output.str();
}

std::string timestampForCsv(std::chrono::system_clock::time_point time) {
    const auto sinceEpoch = std::chrono::duration_cast<std::chrono::nanoseconds>(
        time.time_since_epoch());
    std::int64_t seconds =
        std::chrono::duration_cast<std::chrono::seconds>(sinceEpoch).count();
    std::int64_t nanoseconds =
        (sinceEpoch - std::chrono::seconds{seconds}).count();
    if (nanoseconds < 0) {
        --seconds;
        nanoseconds += 1000000000LL;
    }

    const std::tm seoul = seoulTime(static_cast<std::time_t>(seconds));
    std::ostringstream output;
    const std::int64_t tenths = nanoseconds / 100000000LL;
    output << std::put_time(&seoul, "%Y-%m-%dT%H:%M:%S")
           << '.' << tenths
           << "+09:00";
    return output.str();
}

std::chrono::system_clock::time_point seoulBoundaryAtOrBefore(
    std::chrono::system_clock::time_point time,
    std::uint32_t segmentMinutes) {
    const std::int64_t utcSeconds =
        std::chrono::duration_cast<std::chrono::seconds>(
            time.time_since_epoch()).count();
    const std::int64_t localSeconds = utcSeconds + kSeoulUtcOffsetSeconds;
    const std::int64_t segmentSeconds =
        static_cast<std::int64_t>(segmentMinutes) * 60LL;
    const std::int64_t boundaryLocalSeconds =
        (localSeconds / segmentSeconds) * segmentSeconds;
    return std::chrono::system_clock::time_point{
        std::chrono::seconds{boundaryLocalSeconds - kSeoulUtcOffsetSeconds}};
}

std::chrono::system_clock::time_point nextLoudnessGridPoint(
    std::chrono::system_clock::time_point time) {
    constexpr std::int64_t kGridNanoseconds = 100000000LL;
    const std::int64_t nanoseconds =
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            time.time_since_epoch()).count();
    const std::int64_t alignedNanoseconds =
        ((nanoseconds + kGridNanoseconds - 1LL) / kGridNanoseconds) *
        kGridNanoseconds;
    return std::chrono::system_clock::time_point{
        std::chrono::nanoseconds{alignedNanoseconds}};
}

std::int64_t framesToReach(
    std::chrono::system_clock::time_point from,
    std::chrono::system_clock::time_point to,
    std::uint32_t sampleRate) {
    const std::int64_t nanoseconds =
        std::chrono::duration_cast<std::chrono::nanoseconds>(to - from).count();
    if (nanoseconds <= 0) {
        return 0;
    }
    constexpr std::int64_t kNanosecondsPerSecond = 1000000000LL;
    return (nanoseconds * static_cast<std::int64_t>(sampleRate) +
            kNanosecondsPerSecond - 1LL) / kNanosecondsPerSecond;
}

std::chrono::system_clock::time_point nextSeoulBoundary(
    std::chrono::system_clock::time_point time,
    std::uint32_t segmentMinutes) {
    const std::int64_t utcSeconds =
        std::chrono::duration_cast<std::chrono::seconds>(
            time.time_since_epoch()).count();
    const std::int64_t localSeconds = utcSeconds + kSeoulUtcOffsetSeconds;
    const std::int64_t segmentSeconds =
        static_cast<std::int64_t>(segmentMinutes) * 60LL;
    const std::int64_t nextLocalSeconds =
        ((localSeconds / segmentSeconds) + 1LL) * segmentSeconds;
    const std::int64_t nextUtcSeconds =
        nextLocalSeconds - kSeoulUtcOffsetSeconds;
    return std::chrono::system_clock::time_point{
        std::chrono::seconds{nextUtcSeconds}};
}

std::filesystem::path uniqueWavPath(const std::filesystem::path& directory,
                                    std::chrono::system_clock::time_point start) {
    const std::string stem = timestampForFilename(start);
    std::filesystem::path candidate = directory / (stem + ".wav");
    if (!std::filesystem::exists(candidate)) {
        return candidate;
    }

    for (unsigned int part = 1; part < 10000; ++part) {
        std::ostringstream name;
        name << stem << "_part" << std::setw(2) << std::setfill('0') << part << ".wav";
        candidate = directory / name.str();
        if (!std::filesystem::exists(candidate)) {
            return candidate;
        }
    }
    throw std::runtime_error("Could not choose a unique WAV filename for " + stem);
}

std::filesystem::path uniqueLoudnessPath(
    const std::filesystem::path& directory,
    std::chrono::system_clock::time_point hourStart) {
    const std::string stem = timestampForFilename(hourStart) + "_mlkfs";
    std::filesystem::path candidate = directory / (stem + ".csv");
    if (!std::filesystem::exists(candidate)) {
        return candidate;
    }

    for (unsigned int part = 1; part < 10000; ++part) {
        std::ostringstream name;
        name << stem << "_part" << std::setw(2) << std::setfill('0') << part
             << ".csv";
        candidate = directory / name.str();
        if (!std::filesystem::exists(candidate)) {
            return candidate;
        }
    }
    throw std::runtime_error("Could not choose a unique loudness filename for " + stem);
}

const char* loudnessFilterName(loudness::LKFS::FilterType filterType) {
    return filterType == loudness::LKFS::FilterType::Rbj ? "RBJ" : "DeMan";
}

class MomentaryCsvFile {
public:
    MomentaryCsvFile(const std::filesystem::path& path,
                     loudness::LKFS::FilterType filterType,
                     std::chrono::seconds checkpointInterval)
        : path_(path),
          filterType_(filterType),
          checkpointInterval_(checkpointInterval),
          nextCheckpoint_(std::chrono::steady_clock::now() + checkpointInterval) {
        output_.open(path_, std::ios::out | std::ios::trunc);
        if (!output_) {
            throw std::runtime_error("Could not open loudness log: " + path_.string());
        }
        output_ << "start_time_kst,end_time_kst,start_sample,end_sample,mlkfs,filter\n";
        if (!output_) {
            throw std::runtime_error("Could not write loudness log header: " +
                                     path_.string());
        }
    }

    ~MomentaryCsvFile() {
        try {
            close();
        } catch (...) {
        }
    }

    void write(const loudness::LKFS::MomentaryBlock& block,
               std::chrono::system_clock::time_point start,
               std::chrono::system_clock::time_point end) {
        output_ << timestampForCsv(start) << ','
                << timestampForCsv(end) << ','
                << block.startSample << ','
                << block.endSample << ','
                << std::setprecision(std::numeric_limits<double>::max_digits10)
                << block.mlkfs << ','
                << loudnessFilterName(filterType_) << '\n';
        if (!output_) {
            throw std::runtime_error("Failed while writing loudness log: " +
                                     path_.string());
        }

        if (std::chrono::steady_clock::now() >= nextCheckpoint_) {
            checkpoint();
            nextCheckpoint_ = std::chrono::steady_clock::now() + checkpointInterval_;
        }
    }

    void close() {
        if (!output_.is_open()) {
            return;
        }
        checkpoint();
        output_.close();
        if (output_.fail()) {
            throw std::runtime_error("Failed to close loudness log: " + path_.string());
        }
    }

    const std::filesystem::path& path() const { return path_; }

private:
    void checkpoint() {
        output_.flush();
        if (!output_) {
            throw std::runtime_error("Failed to flush loudness log: " + path_.string());
        }
    }

    std::filesystem::path path_;
    loudness::LKFS::FilterType filterType_;
    std::chrono::seconds checkpointInterval_;
    std::chrono::steady_clock::time_point nextCheckpoint_;
    std::ofstream output_;
};

class WavFile {
public:
    WavFile(const std::filesystem::path& path,
            std::uint32_t sampleRate,
            std::uint16_t channels,
            std::uint16_t bitsPerSample,
            std::chrono::seconds checkpointInterval)
        : path_(path),
          sampleRate_(sampleRate),
          channels_(channels),
          bitsPerSample_(bitsPerSample),
          blockAlign_(static_cast<std::uint16_t>(channels * (bitsPerSample / 8U))),
          checkpointInterval_(checkpointInterval),
          nextCheckpoint_(std::chrono::steady_clock::now() + checkpointInterval) {
        output_.open(path_, std::ios::binary | std::ios::in | std::ios::out | std::ios::trunc);
        if (!output_) {
            throw std::runtime_error("Could not open output file: " + path_.string());
        }
        writeHeader();
    }

    ~WavFile() {
        try {
            close();
        } catch (...) {
        }
    }

    void write(const std::uint8_t* data, std::uint64_t sampleFrames) {
        const std::uint64_t byteCount = sampleFrames * blockAlign_;
        if (dataBytes_ + byteCount > kMaxWaveDataBytes) {
            throw std::runtime_error("WAV file exceeded the RIFF 4 GiB size limit: " +
                                     path_.string());
        }
        output_.write(reinterpret_cast<const char*>(data),
                      static_cast<std::streamsize>(byteCount));
        if (!output_) {
            throw std::runtime_error("Failed while writing PCM data: " + path_.string());
        }
        dataBytes_ += byteCount;

        if (std::chrono::steady_clock::now() >= nextCheckpoint_) {
            checkpoint();
            nextCheckpoint_ = std::chrono::steady_clock::now() + checkpointInterval_;
        }
    }

    void writeSilence(std::uint64_t sampleFrames) {
        constexpr std::size_t kZeroBufferBytes = 1024U * 1024U;
        static const std::array<std::uint8_t, kZeroBufferBytes> zeros{};
        while (sampleFrames > 0) {
            const std::uint64_t framesThisWrite = std::min<std::uint64_t>(
                sampleFrames, zeros.size() / blockAlign_);
            write(zeros.data(), framesThisWrite);
            sampleFrames -= framesThisWrite;
        }
    }

    void close() {
        if (!output_.is_open()) {
            return;
        }
        checkpoint();
        output_.close();
        if (output_.fail()) {
            throw std::runtime_error("Failed to close WAV file: " + path_.string());
        }
    }

    const std::filesystem::path& path() const { return path_; }

private:
    void writeHeader() {
        output_.seekp(0, std::ios::beg);
        output_.write("RIFF", 4);
        writeLe32(output_, static_cast<std::uint32_t>(36U + dataBytes_));
        output_.write("WAVE", 4);
        output_.write("fmt ", 4);
        writeLe32(output_, 16U);
        writeLe16(output_, 1U);  // Linear PCM.
        writeLe16(output_, channels_);
        writeLe32(output_, sampleRate_);
        writeLe32(output_, sampleRate_ * blockAlign_);
        writeLe16(output_, blockAlign_);
        writeLe16(output_, bitsPerSample_);
        output_.write("data", 4);
        writeLe32(output_, static_cast<std::uint32_t>(dataBytes_));
        if (!output_) {
            throw std::runtime_error("Could not write WAV header: " + path_.string());
        }
    }

    void checkpoint() {
        output_.flush();
        if (!output_) {
            throw std::runtime_error("Failed to flush WAV file: " + path_.string());
        }

        output_.seekp(4, std::ios::beg);
        writeLe32(output_, static_cast<std::uint32_t>(36U + dataBytes_));
        output_.seekp(40, std::ios::beg);
        writeLe32(output_, static_cast<std::uint32_t>(dataBytes_));
        output_.flush();
        if (!output_) {
            throw std::runtime_error("Failed to checkpoint WAV header: " + path_.string());
        }
        output_.seekp(0, std::ios::end);
    }

    std::filesystem::path path_;
    std::uint32_t sampleRate_;
    std::uint16_t channels_;
    std::uint16_t bitsPerSample_;
    std::uint16_t blockAlign_;
    std::chrono::seconds checkpointInterval_;
    std::chrono::steady_clock::time_point nextCheckpoint_;
    std::fstream output_;
    std::uint64_t dataBytes_ = 0;
};

std::int64_t framesBetween(std::chrono::system_clock::time_point from,
                           std::chrono::system_clock::time_point to,
                           std::uint32_t sampleRate) {
    const std::chrono::duration<double> duration = to - from;
    return static_cast<std::int64_t>(
        std::llround(duration.count() * static_cast<double>(sampleRate)));
}

std::chrono::system_clock::duration durationForFrames(std::int64_t frames,
                                                       std::uint32_t sampleRate) {
    return std::chrono::duration_cast<std::chrono::system_clock::duration>(
        std::chrono::duration<double>(static_cast<double>(frames) / sampleRate));
}

}  // namespace

WavSegmentWriter::WavSegmentWriter(Config config)
    : config_(std::move(config)),
      blockAlign_(config_.channels * (config_.bitsPerSample / 8U)) {}

WavSegmentWriter::~WavSegmentWriter() {
    stop();
}

bool WavSegmentWriter::validateConfig(const Config& config, std::string& error) {
    if (config.outputDirectory.empty()) {
        error = "Output directory must not be empty";
        return false;
    }
    if (config.sampleRate != 48000) {
        error = "DeckLink audio capture supports 48 kHz in this recorder";
        return false;
    }
    if (config.channels != 2 && config.channels != 8 && config.channels != 16) {
        error = "Audio channels must be 2, 8, or 16";
        return false;
    }
    if (config.bitsPerSample != 16 && config.bitsPerSample != 32) {
        error = "Bits per sample must be 16 or 32";
        return false;
    }
    if (config.segmentMinutes == 0 || config.segmentMinutes > 60 ||
        (60U % config.segmentMinutes) != 0U) {
        error = "Segment minutes must be a divisor of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, or 60)";
        return false;
    }
    if (config.maxQueueBytes == 0) {
        error = "Queue size must be greater than zero";
        return false;
    }

    const std::uint64_t bytesPerSegment =
        static_cast<std::uint64_t>(config.segmentMinutes) * 60U * config.sampleRate *
        config.channels * (config.bitsPerSample / 8U);
    if (bytesPerSegment > kMaxWaveDataBytes) {
        std::ostringstream message;
        message << "A segment would contain " << bytesPerSegment
                << " bytes and exceed the standard WAV 4 GiB limit; shorten --segment-minutes";
        error = message.str();
        return false;
    }
    return true;
}

bool WavSegmentWriter::start(std::string& error) {
    if (!validateConfig(config_, error)) {
        return false;
    }
    std::error_code filesystemError;
    std::filesystem::create_directories(config_.outputDirectory, filesystemError);
    if (filesystemError) {
        error = "Could not create output directory: " + filesystemError.message();
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (running_) {
            error = "Writer is already running";
            return false;
        }
        stopping_ = false;
        running_ = true;
    }
    writerThread_ = std::thread(&WavSegmentWriter::writerLoop, this);
    return true;
}

void WavSegmentWriter::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!running_) {
            return;
        }
        stopping_ = true;
    }
    condition_.notify_all();
    if (writerThread_.joinable()) {
        writerThread_.join();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
}

bool WavSegmentWriter::enqueue(const void* interleavedPcm,
                               std::uint32_t sampleFrames,
                               std::int64_t packetTime,
                               bool packetTimeValid,
                               std::chrono::system_clock::time_point capturedAt) {
    if (interleavedPcm == nullptr || sampleFrames == 0 || fatal_.load()) {
        return false;
    }

    AudioChunk chunk;
    chunk.sampleFrames = sampleFrames;
    chunk.packetTime = packetTime;
    chunk.packetTimeValid = packetTimeValid;
    chunk.capturedAt = capturedAt;
    const std::size_t byteCount = static_cast<std::size_t>(sampleFrames) * blockAlign_;
    try {
        const auto* begin = static_cast<const std::uint8_t*>(interleavedPcm);
        chunk.bytes.assign(begin, begin + byteCount);
    } catch (const std::bad_alloc&) {
        droppedChunks_.fetch_add(1);
        droppedSampleFrames_.fetch_add(sampleFrames);
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!running_ || stopping_ || queuedBytes_ + byteCount > config_.maxQueueBytes) {
            droppedChunks_.fetch_add(1);
            droppedSampleFrames_.fetch_add(sampleFrames);
            return false;
        }
        queuedBytes_ += byteCount;
        queue_.push_back(std::move(chunk));
    }
    queuedChunks_.fetch_add(1);
    condition_.notify_one();
    return true;
}

bool WavSegmentWriter::hasFatalError() const {
    return fatal_.load();
}

std::string WavSegmentWriter::fatalError() const {
    std::lock_guard<std::mutex> lock(fatalMutex_);
    return fatalMessage_;
}

WavSegmentWriter::Stats WavSegmentWriter::stats() const {
    return Stats{
        queuedChunks_.load(),
        droppedChunks_.load(),
        droppedSampleFrames_.load(),
        insertedSilentFrames_.load(),
        writtenSampleFrames_.load(),
    };
}

void WavSegmentWriter::setFatalError(const std::string& error) {
    {
        std::lock_guard<std::mutex> lock(fatalMutex_);
        fatalMessage_ = error;
    }
    fatal_.store(true);
}

void WavSegmentWriter::writerLoop() {
    try {
        std::optional<WavFile> file;
        std::optional<loudness::LKFS> loudnessMeter;
        std::optional<MomentaryCsvFile> loudnessFile;
        std::chrono::system_clock::time_point loudnessFileHour;
        bool loudnessFileHasBeenOpened = false;
        bool timelineInitialized = false;
        bool sourceClockAvailable = false;
        std::int64_t sourceOrigin = 0;
        std::int64_t initialDiscardFramesRemaining = 0;
        std::int64_t outputFrame = 0;
        std::chrono::system_clock::time_point wallOrigin;
        std::chrono::system_clock::time_point nextBoundary;
        std::int64_t nextBoundaryFrame = 0;

        auto storeMomentaries = [&](const std::vector<loudness::LKFS::MomentaryBlock>& blocks) {
            for (const auto& block : blocks) {
                const auto blockStart = wallOrigin +
                    durationForFrames(static_cast<std::int64_t>(block.startSample),
                                      config_.sampleRate);
                const auto blockEnd = wallOrigin +
                    durationForFrames(static_cast<std::int64_t>(block.endSample),
                                      config_.sampleRate);
                const auto hour = seoulBoundaryAtOrBefore(blockStart, 60);
                if (!loudnessFile || hour != loudnessFileHour) {
                    if (loudnessFile) {
                        std::cerr << "Closing loudness log: "
                                  << loudnessFile->path() << '\n';
                        loudnessFile->close();
                        loudnessFile.reset();
                    }
                    // Match the WAV naming rule: the first partial file uses
                    // its actual start time; later files use exact hour starts.
                    const auto filenameTime =
                        loudnessFileHasBeenOpened ? hour : blockStart;
                    const auto path = uniqueLoudnessPath(
                        config_.outputDirectory, filenameTime);
                    loudnessFile.emplace(path, config_.loudnessFilter,
                                         config_.headerCheckpointInterval);
                    loudnessFileHour = hour;
                    loudnessFileHasBeenOpened = true;
                    std::cerr << "Opening loudness log: " << path << '\n';
                }
                loudnessFile->write(block, blockStart, blockEnd);
            }
        };

        auto processLoudness = [&](const std::uint8_t* bytes, std::int64_t frames) {
            if (!loudnessMeter || frames <= 0) {
                return;
            }
            std::vector<loudness::LKFS::MomentaryBlock> blocks;
            if (config_.bitsPerSample == 32) {
                blocks = loudnessMeter->processInterleavedInt32Bytes(
                    bytes,
                    static_cast<std::size_t>(frames), config_.channels);
            } else {
                blocks = loudnessMeter->processInterleavedInt16Bytes(
                    bytes,
                    static_cast<std::size_t>(frames), config_.channels);
            }
            storeMomentaries(blocks);
        };

        std::vector<std::uint8_t> loudnessSilence(
            static_cast<std::size_t>(4096U) * blockAlign_, 0U);
        auto processSilenceLoudness = [&](std::int64_t frames) {
            const std::int64_t bufferFrames = static_cast<std::int64_t>(
                loudnessSilence.size() / blockAlign_);
            while (frames > 0) {
                const std::int64_t count = std::min(frames, bufferFrames);
                processLoudness(loudnessSilence.data(), count);
                frames -= count;
            }
        };

        auto openFile = [&](std::chrono::system_clock::time_point start) {
            if (file) {
                std::cerr << "Closing WAV: " << file->path() << '\n';
                file->close();
                file.reset();
            }
            const auto path = uniqueWavPath(config_.outputDirectory, start);
            file.emplace(path, config_.sampleRate, config_.channels,
                         config_.bitsPerSample, config_.headerCheckpointInterval);
            std::cerr << "Opening WAV: " << path << '\n';
        };

        auto rotateIfNeeded = [&]() {
            while (outputFrame >= nextBoundaryFrame) {
                openFile(nextBoundary);
                nextBoundary = nextSeoulBoundary(nextBoundary, config_.segmentMinutes);
                nextBoundaryFrame = framesBetween(wallOrigin, nextBoundary, config_.sampleRate);
            }
        };

        auto writeSilence = [&](std::int64_t frames) {
            while (frames > 0) {
                rotateIfNeeded();
                const std::int64_t count = std::min(frames, nextBoundaryFrame - outputFrame);
                file->writeSilence(static_cast<std::uint64_t>(count));
                processSilenceLoudness(count);
                outputFrame += count;
                frames -= count;
                insertedSilentFrames_.fetch_add(static_cast<std::uint64_t>(count));
                writtenSampleFrames_.fetch_add(static_cast<std::uint64_t>(count));
            }
        };

        auto writeAudio = [&](const std::uint8_t* bytes, std::int64_t frames) {
            while (frames > 0) {
                rotateIfNeeded();
                const std::int64_t count = std::min(frames, nextBoundaryFrame - outputFrame);
                file->write(bytes, static_cast<std::uint64_t>(count));
                processLoudness(bytes, count);
                bytes += static_cast<std::size_t>(count) * blockAlign_;
                outputFrame += count;
                frames -= count;
                writtenSampleFrames_.fetch_add(static_cast<std::uint64_t>(count));
            }
        };

        while (true) {
            AudioChunk chunk;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                condition_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
                if (queue_.empty()) {
                    if (stopping_) {
                        break;
                    }
                    continue;
                }
                chunk = std::move(queue_.front());
                queuedBytes_ -= chunk.bytes.size();
                queue_.pop_front();
            }

            if (!timelineInitialized) {
                const auto rawWallOrigin = chunk.capturedAt -
                    durationForFrames(chunk.sampleFrames, config_.sampleRate);
                wallOrigin = nextLoudnessGridPoint(rawWallOrigin);
                const std::int64_t alignmentDiscard =
                    framesToReach(rawWallOrigin, wallOrigin, config_.sampleRate);
                sourceClockAvailable = chunk.packetTimeValid;
                sourceOrigin = chunk.packetTime +
                    (sourceClockAvailable ? alignmentDiscard : 0);
                initialDiscardFramesRemaining =
                    sourceClockAvailable ? 0 : alignmentDiscard;
                outputFrame = 0;
                nextBoundary = nextSeoulBoundary(wallOrigin, config_.segmentMinutes);
                nextBoundaryFrame = framesBetween(wallOrigin, nextBoundary, config_.sampleRate);
                loudnessMeter.emplace(
                    config_.loudnessFilter, 0);
                openFile(wallOrigin);
                timelineInitialized = true;
                if (alignmentDiscard > 0) {
                    std::cerr << "Aligning recording to the next 100 ms boundary; "
                              << "discarding " << alignmentDiscard
                              << " initial sample frames\n";
                }
            }

            std::int64_t inputOffset = 0;
            std::int64_t inputFrames = static_cast<std::int64_t>(chunk.sampleFrames);
            if (!sourceClockAvailable && initialDiscardFramesRemaining > 0) {
                const std::int64_t discard =
                    std::min(initialDiscardFramesRemaining, inputFrames);
                inputOffset += discard;
                inputFrames -= discard;
                initialDiscardFramesRemaining -= discard;
                if (inputFrames == 0) {
                    continue;
                }
            }

            std::int64_t targetFrame = outputFrame;
            if (sourceClockAvailable && chunk.packetTimeValid) {
                targetFrame = chunk.packetTime - sourceOrigin;
                if (targetFrame + static_cast<std::int64_t>(chunk.sampleFrames) <
                    outputFrame - static_cast<std::int64_t>(config_.sampleRate)) {
                    // A driver stream restart can reset the DeckLink packet clock.
                    sourceOrigin = chunk.packetTime - outputFrame;
                    targetFrame = outputFrame;
                    std::cerr << "DeckLink packet clock reset; continuing current wall-clock timeline\n";
                }
            }

            if (targetFrame > outputFrame) {
                const std::int64_t missing = targetFrame - outputFrame;
                std::cerr << "Audio discontinuity: inserting " << missing
                          << " silent sample frames\n";
                writeSilence(missing);
            }

            const std::int64_t overlap =
                std::max<std::int64_t>(0, outputFrame - targetFrame);
            if (overlap >= inputFrames) {
                continue;
            }
            const auto* bytes = chunk.bytes.data() +
                static_cast<std::size_t>(inputOffset + overlap) * blockAlign_;
            writeAudio(bytes, inputFrames - overlap);
        }

        if (file) {
            std::cerr << "Closing WAV: " << file->path() << '\n';
            file->close();
        }
        if (loudnessFile) {
            std::cerr << "Closing loudness log: " << loudnessFile->path() << '\n';
            loudnessFile->close();
        }
    } catch (const std::exception& exception) {
        setFatalError(exception.what());
    }
}
