#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace program_audio {

struct Clip {
    std::int64_t startTenths = 0;
    std::int64_t durationSeconds = 0;
    std::string title;
    std::string programId;
};

struct Result {
    std::size_t created = 0;
    std::vector<std::string> warnings;
};

Result exportClips(const std::filesystem::path& recordingsDirectory,
                   const std::filesystem::path& outputDirectory,
                   const std::vector<Clip>& clips,
                   bool replaceExisting);

}  // namespace program_audio
