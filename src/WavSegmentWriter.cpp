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

std::tm localTime(std::time_t value) {
    std::tm result{};
    localtime_r(&value, &result);
    return result;
}

std::string timestampForFilename(std::chrono::system_clock::time_point time) {
    const std::time_t raw = std::chrono::system_clock::to_time_t(time);
    const std::tm local = localTime(raw);
    std::ostringstream output;
    output << std::put_time(&local, "%Y-%m-%d_%H.%M.%S");
    return output.str();
}

std::chrono::system_clock::time_point nextLocalBoundary(
    std::chrono::system_clock::time_point time,
    std::uint32_t segmentMinutes) {
    std::time_t raw = std::chrono::system_clock::to_time_t(time);
    std::tm local = localTime(raw);
    const int currentBucket = local.tm_min / static_cast<int>(segmentMinutes);
    local.tm_min = (currentBucket + 1) * static_cast<int>(segmentMinutes);
    local.tm_sec = 0;
    local.tm_isdst = -1;
    raw = std::mktime(&local);
    return std::chrono::system_clock::from_time_t(raw);
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
        bool timelineInitialized = false;
        bool sourceClockAvailable = false;
        std::int64_t sourceOrigin = 0;
        std::int64_t outputFrame = 0;
        std::chrono::system_clock::time_point wallOrigin;
        std::chrono::system_clock::time_point nextBoundary;
        std::int64_t nextBoundaryFrame = 0;

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
                nextBoundary = nextLocalBoundary(nextBoundary, config_.segmentMinutes);
                nextBoundaryFrame = framesBetween(wallOrigin, nextBoundary, config_.sampleRate);
            }
        };

        auto writeSilence = [&](std::int64_t frames) {
            while (frames > 0) {
                rotateIfNeeded();
                const std::int64_t count = std::min(frames, nextBoundaryFrame - outputFrame);
                file->writeSilence(static_cast<std::uint64_t>(count));
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
                wallOrigin = chunk.capturedAt -
                             durationForFrames(chunk.sampleFrames, config_.sampleRate);
                sourceClockAvailable = chunk.packetTimeValid;
                sourceOrigin = chunk.packetTime;
                outputFrame = 0;
                nextBoundary = nextLocalBoundary(wallOrigin, config_.segmentMinutes);
                nextBoundaryFrame = framesBetween(wallOrigin, nextBoundary, config_.sampleRate);
                openFile(wallOrigin);
                timelineInitialized = true;
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

            std::int64_t overlap = std::max<std::int64_t>(0, outputFrame - targetFrame);
            if (overlap >= static_cast<std::int64_t>(chunk.sampleFrames)) {
                continue;
            }
            const auto* bytes = chunk.bytes.data() +
                                static_cast<std::size_t>(overlap) * blockAlign_;
            writeAudio(bytes, static_cast<std::int64_t>(chunk.sampleFrames) - overlap);
        }

        if (file) {
            std::cerr << "Closing WAV: " << file->path() << '\n';
            file->close();
        }
    } catch (const std::exception& exception) {
        setFatalError(exception.what());
    }
}
