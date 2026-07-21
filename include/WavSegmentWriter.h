#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class WavSegmentWriter {
public:
    struct Config {
        std::filesystem::path outputDirectory;
        std::uint32_t sampleRate = 48000;
        std::uint16_t channels = 2;
        std::uint16_t bitsPerSample = 32;
        std::uint32_t segmentMinutes = 60;
        std::size_t maxQueueBytes = 64U * 1024U * 1024U;
        std::chrono::seconds headerCheckpointInterval{5};
    };

    struct Stats {
        std::uint64_t queuedChunks = 0;
        std::uint64_t droppedChunks = 0;
        std::uint64_t droppedSampleFrames = 0;
        std::uint64_t insertedSilentFrames = 0;
        std::uint64_t writtenSampleFrames = 0;
    };

    explicit WavSegmentWriter(Config config);
    ~WavSegmentWriter();

    WavSegmentWriter(const WavSegmentWriter&) = delete;
    WavSegmentWriter& operator=(const WavSegmentWriter&) = delete;

    bool start(std::string& error);
    void stop();

    // packetTime is the DeckLink audio packet time in sample-rate units.
    // Pass packetTimeValid=false only when the SDK cannot provide it.
    bool enqueue(const void* interleavedPcm,
                 std::uint32_t sampleFrames,
                 std::int64_t packetTime,
                 bool packetTimeValid,
                 std::chrono::system_clock::time_point capturedAt);

    bool hasFatalError() const;
    std::string fatalError() const;
    Stats stats() const;

    static bool validateConfig(const Config& config, std::string& error);

private:
    struct AudioChunk {
        std::vector<std::uint8_t> bytes;
        std::uint32_t sampleFrames = 0;
        std::int64_t packetTime = 0;
        bool packetTimeValid = false;
        std::chrono::system_clock::time_point capturedAt;
    };

    void writerLoop();
    void setFatalError(const std::string& error);

    Config config_;
    const std::size_t blockAlign_;

    mutable std::mutex mutex_;
    std::condition_variable condition_;
    std::deque<AudioChunk> queue_;
    std::size_t queuedBytes_ = 0;
    bool stopping_ = false;
    bool running_ = false;
    std::thread writerThread_;

    std::atomic<bool> fatal_{false};
    mutable std::mutex fatalMutex_;
    std::string fatalMessage_;

    std::atomic<std::uint64_t> queuedChunks_{0};
    std::atomic<std::uint64_t> droppedChunks_{0};
    std::atomic<std::uint64_t> droppedSampleFrames_{0};
    std::atomic<std::uint64_t> insertedSilentFrames_{0};
    std::atomic<std::uint64_t> writtenSampleFrames_{0};
};
