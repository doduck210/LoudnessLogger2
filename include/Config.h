#pragma once

#include <filesystem>

namespace config {

// ---------------------------------------------------------------------------
// Default storage location
//
// Change only this line when the recording disk is mounted somewhere else.
// The recorder and report generator both use this value.
// ---------------------------------------------------------------------------
inline const std::filesystem::path kStorageRoot = "/mnt/hdd";

inline const std::filesystem::path kRecordingsDirectory =
    kStorageRoot / "recordings";
inline const std::filesystem::path kSchedulesDirectory =
    kStorageRoot / "schedules";
inline const std::filesystem::path kReportsDirectory =
    kStorageRoot / "reports";
inline const std::filesystem::path kProgramAudioDirectory =
    kReportsDirectory / "program_audio";

}  // namespace config
