#include "ProgramAudioExporter.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <unistd.h>
#include <vector>

namespace {

constexpr std::int64_t kSeoulUtcOffsetSeconds = 9LL * 60LL * 60LL;
constexpr std::size_t kCopyBufferBytes = 1024U * 1024U;

std::uint16_t readLe16(std::istream& input) {
    std::array<unsigned char, 2> bytes{};
    input.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
    if (!input) throw std::runtime_error("Truncated WAV header");
    return static_cast<std::uint16_t>(
        bytes[0] | (static_cast<std::uint16_t>(bytes[1]) << 8U));
}

std::uint32_t readLe32(std::istream& input) {
    std::array<unsigned char, 4> bytes{};
    input.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
    if (!input) throw std::runtime_error("Truncated WAV header");
    return static_cast<std::uint32_t>(
        bytes[0] |
        (static_cast<std::uint32_t>(bytes[1]) << 8U) |
        (static_cast<std::uint32_t>(bytes[2]) << 16U) |
        (static_cast<std::uint32_t>(bytes[3]) << 24U));
}

void writeLe16(std::ostream& output, std::uint16_t value) {
    const std::array<char, 2> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
    };
    output.write(bytes.data(), bytes.size());
}

void writeLe32(std::ostream& output, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU),
    };
    output.write(bytes.data(), bytes.size());
}

struct WavSource {
    std::filesystem::path path;
    std::int64_t startNanoseconds = 0;
    std::int64_t endNanoseconds = 0;
    std::uint64_t dataOffset = 0;
    std::uint64_t dataBytes = 0;
    std::uint32_t sampleRate = 0;
    std::uint16_t channels = 0;
    std::uint16_t bitsPerSample = 0;
    std::uint16_t blockAlign = 0;
};

std::optional<std::int64_t> filenameStartNanoseconds(
    const std::filesystem::path& path) {
    const std::string name = path.filename().string();
    if (name.size() < 23 || name.substr(19, 4) != ".wav") {
        if (name.size() < 30 ||
            name.compare(19, 5, "_part") != 0 ||
            name.substr(name.size() - 4) != ".wav") {
            return std::nullopt;
        }
    }
    std::tm value{};
    std::istringstream input(name.substr(0, 19));
    input >> std::get_time(&value, "%Y-%m-%d_%H.%M.%S");
    if (!input) return std::nullopt;
    const std::time_t localAsUtc = timegm(&value);
    if (localAsUtc == static_cast<std::time_t>(-1)) return std::nullopt;
    const std::int64_t utcSeconds =
        static_cast<std::int64_t>(localAsUtc) - kSeoulUtcOffsetSeconds;
    return utcSeconds * 1000000000LL;
}

std::optional<std::int64_t> parseKstTimestampNanoseconds(
    const std::string& timestamp) {
    if (timestamp.size() < 19) return std::nullopt;
    std::string base = timestamp.substr(0, 19);
    std::replace(base.begin(), base.end(), 'T', ' ');
    std::tm value{};
    std::istringstream parser(base);
    parser >> std::get_time(&value, "%Y-%m-%d %H:%M:%S");
    if (!parser) return std::nullopt;
    const std::time_t localAsUtc = timegm(&value);
    if (localAsUtc == static_cast<std::time_t>(-1)) return std::nullopt;
    std::int64_t nanoseconds = 0;
    if (timestamp.size() > 20 && timestamp[19] == '.') {
        std::size_t position = 20;
        int digits = 0;
        while (position < timestamp.size() &&
               std::isdigit(static_cast<unsigned char>(timestamp[position])) &&
               digits < 9) {
            nanoseconds = nanoseconds * 10 + (timestamp[position] - '0');
            ++position;
            ++digits;
        }
        while (digits++ < 9) nanoseconds *= 10;
    }
    return (static_cast<std::int64_t>(localAsUtc) -
            kSeoulUtcOffsetSeconds) * 1000000000LL + nanoseconds;
}

std::optional<std::pair<std::int64_t, std::int64_t>> timingInterval(
    const std::filesystem::path& wavPath) {
    std::filesystem::path timingPath = wavPath;
    timingPath.replace_extension(".timing.csv");
    std::ifstream input(timingPath);
    std::string header;
    std::string row;
    if (!input || !std::getline(input, header) || !std::getline(input, row)) {
        return std::nullopt;
    }
    const std::size_t firstComma = row.find(',');
    const std::size_t secondComma =
        firstComma == std::string::npos
            ? std::string::npos
            : row.find(',', firstComma + 1);
    if (firstComma == std::string::npos || secondComma == std::string::npos) {
        throw std::runtime_error("Invalid WAV timing metadata: " +
                                 timingPath.string());
    }
    const auto start = parseKstTimestampNanoseconds(
        row.substr(0, firstComma));
    const auto end = parseKstTimestampNanoseconds(
        row.substr(firstComma + 1, secondComma - firstComma - 1));
    if (!start || !end || *end <= *start) {
        throw std::runtime_error("Invalid WAV timing interval: " +
                                 timingPath.string());
    }
    return std::make_pair(*start, *end);
}

WavSource readWavSource(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open WAV: " + path.string());
    }
    std::array<char, 4> id{};
    input.read(id.data(), id.size());
    if (!input || std::string(id.data(), id.size()) != "RIFF") {
        throw std::runtime_error("Not a RIFF WAV: " + path.string());
    }
    (void)readLe32(input);
    input.read(id.data(), id.size());
    if (!input || std::string(id.data(), id.size()) != "WAVE") {
        throw std::runtime_error("Not a WAVE file: " + path.string());
    }

    WavSource source;
    source.path = path;
    bool haveFormat = false;
    bool haveData = false;
    while (input && !haveData) {
        input.read(id.data(), id.size());
        if (!input) break;
        const std::uint32_t chunkSize = readLe32(input);
        const std::string chunkId(id.data(), id.size());
        const std::streamoff payload = input.tellg();
        if (chunkId == "fmt ") {
            if (chunkSize < 16U || readLe16(input) != 1U) {
                throw std::runtime_error(
                    "Only linear PCM WAV is supported: " + path.string());
            }
            source.channels = readLe16(input);
            source.sampleRate = readLe32(input);
            (void)readLe32(input);
            source.blockAlign = readLe16(input);
            source.bitsPerSample = readLe16(input);
            haveFormat = true;
        } else if (chunkId == "data") {
            source.dataOffset = static_cast<std::uint64_t>(payload);
            source.dataBytes = chunkSize;
            haveData = true;
        }
        input.seekg(payload + static_cast<std::streamoff>(
            chunkSize + (chunkSize & 1U)));
    }
    if (!haveFormat || !haveData || source.sampleRate == 0 ||
        source.blockAlign == 0 || source.channels == 0) {
        throw std::runtime_error("Incomplete WAV header: " + path.string());
    }
    const auto interval = timingInterval(path);
    auto start = interval
        ? std::optional<std::int64_t>(interval->first)
        : filenameStartNanoseconds(path);
    if (!start) {
        throw std::runtime_error(
            "WAV filename does not contain a Seoul start time: " +
            path.string());
    }
    const std::uint64_t actualSize = std::filesystem::file_size(path);
    if (source.dataOffset > actualSize) {
        throw std::runtime_error("Invalid WAV data offset: " + path.string());
    }
    source.dataBytes =
        std::min(source.dataBytes, actualSize - source.dataOffset);
    source.dataBytes -= source.dataBytes % source.blockAlign;
    source.startNanoseconds = *start;
    const std::uint64_t frames = source.dataBytes / source.blockAlign;
    if (frames > static_cast<std::uint64_t>(
                     std::numeric_limits<std::int64_t>::max())) {
        throw std::runtime_error("WAV is too large: " + path.string());
    }
    source.endNanoseconds = interval
        ? interval->second
        : source.startNanoseconds + static_cast<std::int64_t>(
              (static_cast<long double>(frames) * 1000000000.0L) /
              static_cast<long double>(source.sampleRate));
    return source;
}

std::vector<WavSource> loadSources(
    const std::filesystem::path& recordingsDirectory) {
    if (!std::filesystem::is_directory(recordingsDirectory)) {
        throw std::runtime_error(
            "Recordings directory does not exist: " +
            recordingsDirectory.string());
    }
    std::vector<WavSource> sources;
    for (const auto& entry :
         std::filesystem::directory_iterator(recordingsDirectory)) {
        if (!entry.is_regular_file() ||
            entry.path().extension() != ".wav") {
            continue;
        }
        sources.push_back(readWavSource(entry.path()));
    }
    std::sort(sources.begin(), sources.end(),
              [](const WavSource& left, const WavSource& right) {
                  if (left.startNanoseconds != right.startNanoseconds) {
                      return left.startNanoseconds < right.startNanoseconds;
                  }
                  return left.path < right.path;
              });
    return sources;
}

std::string clipFileComponent(std::string value) {
    for (char& character : value) {
        const unsigned char byte = static_cast<unsigned char>(character);
        if (byte < 0x20U || character == '/' || character == '\\' ||
            character == ':' || character == '*' || character == '?' ||
            character == '"' || character == '<' || character == '>' ||
            character == '|') {
            character = '_';
        } else if (std::isspace(byte)) {
            character = '_';
        }
    }
    while (!value.empty() &&
           (value.back() == '.' || value.back() == '_' ||
            value.back() == ' ')) {
        value.pop_back();
    }
    if (value.empty()) value = "Untitled";
    constexpr std::size_t kMaxBytes = 150;
    if (value.size() > kMaxBytes) {
        std::size_t end = kMaxBytes;
        while (end > 0 &&
               (static_cast<unsigned char>(value[end]) & 0xc0U) == 0x80U) {
            --end;
        }
        value.resize(end);
    }
    return value;
}

std::string timeForFilename(std::int64_t startTenths) {
    const std::time_t shifted = static_cast<std::time_t>(
        startTenths / 10 + kSeoulUtcOffsetSeconds);
    std::tm value{};
    gmtime_r(&shifted, &value);
    std::ostringstream output;
    output << std::put_time(&value, "%H.%M.%S");
    return output.str();
}

void writeWavHeader(std::ostream& output,
                    const WavSource& format,
                    std::uint64_t dataBytes) {
    if (dataBytes > std::numeric_limits<std::uint32_t>::max() - 36U) {
        throw std::runtime_error(
            "Programme audio exceeds the standard WAV 4 GiB limit");
    }
    output.write("RIFF", 4);
    writeLe32(output, static_cast<std::uint32_t>(36U + dataBytes));
    output.write("WAVEfmt ", 8);
    writeLe32(output, 16U);
    writeLe16(output, 1U);
    writeLe16(output, format.channels);
    writeLe32(output, format.sampleRate);
    writeLe32(output, format.sampleRate * format.blockAlign);
    writeLe16(output, format.blockAlign);
    writeLe16(output, format.bitsPerSample);
    output.write("data", 4);
    writeLe32(output, static_cast<std::uint32_t>(dataBytes));
}

const WavSource* sourceAt(const std::vector<WavSource>& sources,
                          std::int64_t nanoseconds) {
    const WavSource* found = nullptr;
    for (const WavSource& source : sources) {
        if (source.startNanoseconds > nanoseconds) break;
        if (source.startNanoseconds <= nanoseconds &&
            source.endNanoseconds > nanoseconds) {
            if (found != nullptr) {
                throw std::runtime_error(
                    "Overlapping WAV files: " + found->path.string() +
                    " and " + source.path.string());
            }
            found = &source;
        }
    }
    return found;
}

std::int64_t frameAtWallTime(const WavSource& source,
                             std::int64_t nanoseconds) {
    const std::int64_t clamped = std::max(
        source.startNanoseconds,
        std::min(source.endNanoseconds, nanoseconds));
    const std::uint64_t totalFrames = source.dataBytes / source.blockAlign;
    const long double ratio =
        static_cast<long double>(clamped - source.startNanoseconds) /
        static_cast<long double>(source.endNanoseconds -
                                 source.startNanoseconds);
    return static_cast<std::int64_t>(std::llround(
        ratio * static_cast<long double>(totalFrames)));
}

void copyClip(const std::vector<WavSource>& sources,
              const program_audio::Clip& clip,
              const std::filesystem::path& outputPath) {
    if (sources.empty()) {
        throw std::runtime_error("No WAV recordings were found");
    }
    const WavSource& format = sources.front();
    const std::int64_t startNanoseconds = clip.startTenths * 100000000LL;
    const std::int64_t endNanoseconds = startNanoseconds +
        clip.durationSeconds * 1000000000LL;

    struct Span {
        const WavSource* source;
        std::int64_t firstFrame;
        std::int64_t frameCount;
    };
    std::vector<Span> spans;
    std::int64_t cursor = startNanoseconds;
    std::uint64_t totalFrames = 0;
    while (cursor < endNanoseconds) {
        const WavSource* source = sourceAt(sources, cursor);
        if (!source) {
            throw std::runtime_error(
                "No WAV data at programme offset " +
                std::to_string((cursor - startNanoseconds) / 1000000000LL) +
                " seconds");
        }
        const std::int64_t spanEnd =
            std::min(endNanoseconds, source->endNanoseconds);
        const std::int64_t firstFrame = frameAtWallTime(*source, cursor);
        const std::int64_t lastFrame = frameAtWallTime(*source, spanEnd);
        if (lastFrame <= firstFrame) {
            throw std::runtime_error("Invalid zero-length WAV timing span: " +
                                     source->path.string());
        }
        spans.push_back({source, firstFrame, lastFrame - firstFrame});
        totalFrames += static_cast<std::uint64_t>(lastFrame - firstFrame);
        cursor = spanEnd;
    }
    const std::uint64_t outputBytes = totalFrames * format.blockAlign;

    std::ofstream output(outputPath, std::ios::binary | std::ios::trunc);
    if (!output) {
        throw std::runtime_error(
            "Could not create clip: " + outputPath.string());
    }
    writeWavHeader(output, format, outputBytes);

    std::vector<char> buffer(kCopyBufferBytes);
    for (const Span& span : spans) {
        const WavSource* source = span.source;
        if (source->sampleRate != format.sampleRate ||
            source->channels != format.channels ||
            source->bitsPerSample != format.bitsPerSample ||
            source->blockAlign != format.blockAlign) {
            throw std::runtime_error(
                "WAV format changed at " + source->path.string());
        }
        std::uint64_t bytes =
            static_cast<std::uint64_t>(span.frameCount) * format.blockAlign;
        const std::uint64_t sourceByte =
            source->dataOffset +
            static_cast<std::uint64_t>(span.firstFrame) *
                format.blockAlign;
        std::ifstream input(source->path, std::ios::binary);
        input.seekg(static_cast<std::streamoff>(sourceByte));
        if (!input) {
            throw std::runtime_error(
                "Could not seek WAV: " + source->path.string());
        }
        while (bytes > 0) {
            const std::size_t count = static_cast<std::size_t>(
                std::min<std::uint64_t>(bytes, buffer.size()));
            input.read(buffer.data(), static_cast<std::streamsize>(count));
            if (input.gcount() != static_cast<std::streamsize>(count)) {
                throw std::runtime_error(
                    "Unexpected end of WAV: " + source->path.string());
            }
            output.write(buffer.data(), static_cast<std::streamsize>(count));
            if (!output) {
                throw std::runtime_error(
                    "Failed while writing clip: " + outputPath.string());
            }
            bytes -= count;
        }
    }
    output.close();
    if (!output) {
        throw std::runtime_error(
            "Could not finish clip: " + outputPath.string());
    }
}

}  // namespace

namespace program_audio {

Result exportClips(const std::filesystem::path& recordingsDirectory,
                   const std::filesystem::path& outputDirectory,
                   const std::vector<Clip>& clips,
                   bool replaceExisting) {
    const std::vector<WavSource> sources = loadSources(recordingsDirectory);
    const std::filesystem::path temporary =
        outputDirectory.string() + ".tmp-" + std::to_string(getpid());
    std::error_code error;
    std::filesystem::remove_all(temporary, error);
    error.clear();
    std::filesystem::create_directories(temporary, error);
    if (error) {
        throw std::runtime_error(
            "Could not create audio output directory: " + error.message());
    }

    Result result;
    try {
        for (std::size_t index = 0; index < clips.size(); ++index) {
            const Clip& clip = clips[index];
            const std::uint64_t bytesPerSecond =
                sources.empty()
                    ? 1U
                    : static_cast<std::uint64_t>(
                          sources.front().sampleRate) *
                          sources.front().blockAlign;
            const std::int64_t maxPartSeconds =
                static_cast<std::int64_t>(
                    (std::numeric_limits<std::uint32_t>::max() - 36U) /
                    bytesPerSecond);
            const std::int64_t partCount =
                (clip.durationSeconds + maxPartSeconds - 1) /
                maxPartSeconds;
            std::vector<std::filesystem::path> createdPaths;
            bool complete = true;
            for (std::int64_t part = 0; part < partCount; ++part) {
                const std::int64_t offsetSeconds = part * maxPartSeconds;
                Clip piece = clip;
                piece.startTenths += offsetSeconds * 10;
                piece.durationSeconds = std::min(
                    maxPartSeconds, clip.durationSeconds - offsetSeconds);
                std::ostringstream name;
                name << std::setw(3) << std::setfill('0') << index + 1 << '_'
                     << timeForFilename(clip.startTenths) << '_'
                     << clipFileComponent(clip.title);
                if (partCount > 1) {
                    name << "_part" << std::setw(2) << std::setfill('0')
                         << part + 1;
                }
                name << ".wav";
                const std::filesystem::path path = temporary / name.str();
                try {
                    copyClip(sources, piece, path);
                    createdPaths.push_back(path);
                } catch (const std::exception& exception) {
                    complete = false;
                    result.warnings.push_back(
                        std::to_string(index + 1) + " " + clip.title + ": " +
                        exception.what());
                    break;
                }
            }
            if (complete) {
                result.created += createdPaths.size();
                std::cout << "Audio [" << index + 1 << '/' << clips.size()
                          << "] created: " << clip.title;
                if (createdPaths.size() > 1) {
                    std::cout << " (" << createdPaths.size() << " parts)";
                }
                std::cout << std::endl;
            } else {
                for (const auto& path : createdPaths) {
                    std::filesystem::remove(path, error);
                }
                std::cout << "Audio [" << index + 1 << '/' << clips.size()
                          << "] skipped: " << clip.title << std::endl;
            }
        }

        if (std::filesystem::exists(outputDirectory)) {
            if (!replaceExisting) {
                throw std::runtime_error(
                    "Audio output already exists; use --force: " +
                    outputDirectory.string());
            }
            std::filesystem::remove_all(outputDirectory, error);
            if (error) {
                throw std::runtime_error(
                    "Could not replace audio output: " + error.message());
            }
        }
        std::filesystem::rename(temporary, outputDirectory, error);
        if (error) {
            throw std::runtime_error(
                "Could not publish audio output: " + error.message());
        }
    } catch (...) {
        std::filesystem::remove_all(temporary, error);
        throw;
    }
    return result;
}

}  // namespace program_audio
