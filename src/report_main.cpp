#include "Config.h"
#include "LKFS.h"
#include "ProgramAudioExporter.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <getopt.h>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <netdb.h>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
#include <utility>
#include <variant>
#include <vector>

namespace {

constexpr std::int64_t kSeoulUtcOffsetSeconds = 9LL * 60LL * 60LL;

struct Options {
    std::string date;
    std::filesystem::path recordingsDirectory = config::kRecordingsDirectory;
    std::filesystem::path output;
    std::filesystem::path audioOutputDirectory;
    std::filesystem::path scheduleJson;
    std::filesystem::path scheduleOutput;
    std::string apiHost = "10.110.21.31";
    std::string apiPort = "80";
    std::string channelName = "SBS_HD";
    bool showHelp = false;
    bool force = false;
    bool createAudio = true;
    bool audioOnly = false;
};

struct Program {
    std::int64_t startTenths = 0;
    std::int64_t endTenths = 0;
    std::int64_t durationSeconds = 0;
    std::string title;
    std::string id;
    std::optional<double> integratedLoudness;
    std::size_t blockCount = 0;
    std::size_t expectedBlockCount = 0;
};

struct Momentary {
    std::int64_t startTenths = 0;
    std::int64_t endTenths = 0;
    double value = -std::numeric_limits<double>::infinity();
    std::string filter;
};

void printUsage(const char* program) {
    std::cout
        << "Usage: " << program << " --date YYYY-MM-DD [options]\n\n"
        << "  -d, --date DATE              Broadcast schedule date (required)\n"
        << "  -r, --recordings DIRECTORY   M-LKFS CSV directory (default: "
        << config::kRecordingsDirectory.string() << ")\n"
        << "  -o, --output FILE            Output .xlsx or .csv path\n"
        << "      --audio-output DIRECTORY Programme WAV output directory\n"
        << "      --audio-only             Create programme WAV files only\n"
        << "      --no-audio               Do not create programme WAV files\n"
        << "      --channel NAME           Default output prefix (default: SBS_HD)\n"
        << "      --schedule-json FILE     Read saved API JSON instead of HTTP\n"
        << "      --schedule-output FILE   Save used schedule JSON to this path\n"
        << "      --api-host HOST          Schedule API host (default: 10.110.21.31)\n"
        << "      --api-port PORT          Schedule API port (default: 80)\n"
        << "  -f, --force                  Replace an existing report\n"
        << "  -h, --help                   Show this help\n\n"
        << "Example:\n"
        << "  " << program
        << " --date 2026-07-23\n";
}

Options parseOptions(int argc, char** argv) {
    Options options;
    constexpr option longOptions[] = {
        {"date", required_argument, nullptr, 'd'},
        {"recordings", required_argument, nullptr, 'r'},
        {"output", required_argument, nullptr, 'o'},
        {"channel", required_argument, nullptr, 1000},
        {"schedule-json", required_argument, nullptr, 1001},
        {"schedule-output", required_argument, nullptr, 1002},
        {"api-host", required_argument, nullptr, 1003},
        {"api-port", required_argument, nullptr, 1004},
        {"audio-output", required_argument, nullptr, 1005},
        {"no-audio", no_argument, nullptr, 1006},
        {"audio-only", no_argument, nullptr, 1007},
        {"force", no_argument, nullptr, 'f'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };

    while (true) {
        const int choice = getopt_long(argc, argv, "d:r:o:fh", longOptions, nullptr);
        if (choice == -1) {
            break;
        }
        switch (choice) {
            case 'd': options.date = optarg; break;
            case 'r': options.recordingsDirectory = optarg; break;
            case 'o': options.output = optarg; break;
            case 1000: options.channelName = optarg; break;
            case 1001: options.scheduleJson = optarg; break;
            case 1002: options.scheduleOutput = optarg; break;
            case 1003: options.apiHost = optarg; break;
            case 1004: options.apiPort = optarg; break;
            case 1005: options.audioOutputDirectory = optarg; break;
            case 1006: options.createAudio = false; break;
            case 1007:
                options.audioOnly = true;
                options.createAudio = true;
                break;
            case 'f': options.force = true; break;
            case 'h': options.showHelp = true; break;
            default: throw std::invalid_argument("Invalid command-line option");
        }
    }
    if (optind != argc) {
        throw std::invalid_argument("Unexpected argument: " +
                                    std::string(argv[optind]));
    }
    if (!options.showHelp && options.date.empty()) {
        throw std::invalid_argument("--date is required");
    }
    if (!options.showHelp && !options.audioOnly && options.output.empty()) {
        options.output =
            config::kReportsDirectory /
            (options.channelName + "_Loudness_Report_" +
             options.date + ".xlsx");
    }
    if (!options.showHelp && !options.audioOnly &&
        options.scheduleOutput.empty()) {
        options.scheduleOutput =
            config::kSchedulesDirectory /
            (options.channelName + "_Schedule_" + options.date + ".json");
    }
    if (!options.showHelp && options.createAudio &&
        options.audioOutputDirectory.empty()) {
        options.audioOutputDirectory =
            config::kProgramAudioDirectory / options.channelName / options.date;
    }
    return options;
}

std::string readFile(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open file: " + path.string());
    }
    std::ostringstream data;
    data << input.rdbuf();
    if (!input.good() && !input.eof()) {
        throw std::runtime_error("Could not read file: " + path.string());
    }
    return data.str();
}

void writeFile(const std::filesystem::path& path, const std::string& data) {
    if (!path.parent_path().empty()) {
        std::error_code error;
        std::filesystem::create_directories(path.parent_path(), error);
        if (error) {
            throw std::runtime_error("Could not create schedule directory: " +
                                     error.message());
        }
    }
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("Could not open schedule output: " +
                                 path.string());
    }
    output.write(data.data(), static_cast<std::streamsize>(data.size()));
    output.flush();
    if (!output) {
        throw std::runtime_error("Could not write schedule output: " +
                                 path.string());
    }
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::string decodeChunked(const std::string& body) {
    std::string result;
    std::size_t position = 0;
    while (true) {
        const std::size_t lineEnd = body.find("\r\n", position);
        if (lineEnd == std::string::npos) {
            throw std::runtime_error("Malformed chunked HTTP response");
        }
        const std::string sizeText = body.substr(position, lineEnd - position);
        std::size_t parsed = 0;
        const std::uint64_t size = std::stoull(sizeText, &parsed, 16);
        if (parsed == 0) {
            throw std::runtime_error("Malformed HTTP chunk size");
        }
        position = lineEnd + 2;
        if (size == 0) {
            break;
        }
        if (size > body.size() - position) {
            throw std::runtime_error("Truncated chunked HTTP response");
        }
        result.append(body, position, static_cast<std::size_t>(size));
        position += static_cast<std::size_t>(size);
        if (body.compare(position, 2, "\r\n") != 0) {
            throw std::runtime_error("Malformed HTTP chunk terminator");
        }
        position += 2;
    }
    return result;
}

std::string httpGet(const std::string& host,
                    const std::string& port,
                    const std::string& path) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* addresses = nullptr;
    const int lookup = getaddrinfo(host.c_str(), port.c_str(), &hints, &addresses);
    if (lookup != 0) {
        throw std::runtime_error("Could not resolve API host: " +
                                 std::string(gai_strerror(lookup)));
    }

    int socketFd = -1;
    for (addrinfo* address = addresses; address != nullptr;
         address = address->ai_next) {
        socketFd = socket(address->ai_family, address->ai_socktype,
                          address->ai_protocol);
        if (socketFd < 0) {
            continue;
        }
        timeval timeout{};
        timeout.tv_sec = 15;
        setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(socketFd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        if (connect(socketFd, address->ai_addr, address->ai_addrlen) == 0) {
            break;
        }
        close(socketFd);
        socketFd = -1;
    }
    freeaddrinfo(addresses);
    if (socketFd < 0) {
        throw std::runtime_error("Could not connect to schedule API " +
                                 host + ':' + port);
    }

    const std::string request =
        "GET " + path + " HTTP/1.1\r\nHost: " + host +
        "\r\nAccept: application/json\r\nConnection: close\r\n"
        "User-Agent: LoudnessLogger2/1.0\r\n\r\n";
    std::size_t sent = 0;
    while (sent < request.size()) {
        const ssize_t count =
            send(socketFd, request.data() + sent, request.size() - sent, 0);
        if (count <= 0) {
            const int error = errno;
            close(socketFd);
            throw std::runtime_error("Could not send API request: " +
                                     std::string(std::strerror(error)));
        }
        sent += static_cast<std::size_t>(count);
    }

    std::string response;
    std::array<char, 16384> buffer{};
    while (true) {
        const ssize_t count = recv(socketFd, buffer.data(), buffer.size(), 0);
        if (count == 0) {
            break;
        }
        if (count < 0) {
            const int error = errno;
            close(socketFd);
            throw std::runtime_error("Could not receive API response: " +
                                     std::string(std::strerror(error)));
        }
        response.append(buffer.data(), static_cast<std::size_t>(count));
    }
    close(socketFd);

    const std::size_t headerEnd = response.find("\r\n\r\n");
    if (headerEnd == std::string::npos) {
        throw std::runtime_error("Malformed HTTP response");
    }
    const std::size_t statusEnd = response.find("\r\n");
    const std::string statusLine = response.substr(0, statusEnd);
    if (statusLine.find(" 200 ") == std::string::npos) {
        throw std::runtime_error("Schedule API returned " + statusLine);
    }
    const std::string headers = toLower(
        response.substr(statusEnd + 2, headerEnd - statusEnd - 2));
    const std::string body = response.substr(headerEnd + 4);
    if (headers.find("transfer-encoding: chunked") != std::string::npos) {
        return decodeChunked(body);
    }
    return body;
}

struct Json {
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;
    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> value;

    const Object& object() const { return std::get<Object>(value); }
    const Array& array() const { return std::get<Array>(value); }
    const std::string& string() const { return std::get<std::string>(value); }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& input) : input_(input) {}

    Json parse() {
        Json result = parseValue();
        skipWhitespace();
        if (position_ != input_.size()) {
            fail("Unexpected content after JSON value");
        }
        return result;
    }

private:
    [[noreturn]] void fail(const std::string& message) const {
        throw std::runtime_error("JSON parse error at byte " +
                                 std::to_string(position_) + ": " + message);
    }

    void skipWhitespace() {
        while (position_ < input_.size() &&
               (input_[position_] == ' ' || input_[position_] == '\n' ||
                input_[position_] == '\r' || input_[position_] == '\t')) {
            ++position_;
        }
    }

    bool consume(char expected) {
        skipWhitespace();
        if (position_ < input_.size() && input_[position_] == expected) {
            ++position_;
            return true;
        }
        return false;
    }

    Json parseValue() {
        skipWhitespace();
        if (position_ >= input_.size()) {
            fail("Unexpected end of input");
        }
        const char current = input_[position_];
        if (current == '{') return Json{parseObject()};
        if (current == '[') return Json{parseArray()};
        if (current == '"') return Json{parseString()};
        if (current == 't') return parseLiteral("true", Json{true});
        if (current == 'f') return parseLiteral("false", Json{false});
        if (current == 'n') return parseLiteral("null", Json{nullptr});
        if (current == '-' || (current >= '0' && current <= '9')) {
            return Json{parseNumber()};
        }
        fail("Invalid value");
    }

    Json parseLiteral(const char* text, Json value) {
        const std::size_t length = std::strlen(text);
        if (input_.compare(position_, length, text) != 0) {
            fail("Invalid literal");
        }
        position_ += length;
        return value;
    }

    Json::Object parseObject() {
        consume('{');
        Json::Object result;
        if (consume('}')) return result;
        while (true) {
            skipWhitespace();
            if (position_ >= input_.size() || input_[position_] != '"') {
                fail("Object key is not a string");
            }
            std::string key = parseString();
            if (!consume(':')) fail("Missing colon after object key");
            result.emplace(std::move(key), parseValue());
            if (consume('}')) break;
            if (!consume(',')) fail("Missing comma in object");
        }
        return result;
    }

    Json::Array parseArray() {
        consume('[');
        Json::Array result;
        if (consume(']')) return result;
        while (true) {
            result.push_back(parseValue());
            if (consume(']')) break;
            if (!consume(',')) fail("Missing comma in array");
        }
        return result;
    }

    static void appendUtf8(std::string& output, std::uint32_t codepoint) {
        if (codepoint <= 0x7fU) {
            output.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7ffU) {
            output.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else if (codepoint <= 0xffffU) {
            output.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else {
            output.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        }
    }

    std::uint32_t parseHex4() {
        if (position_ + 4 > input_.size()) fail("Truncated Unicode escape");
        std::uint32_t value = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = input_[position_++];
            value <<= 4U;
            if (c >= '0' && c <= '9') value += static_cast<std::uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') value += static_cast<std::uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') value += static_cast<std::uint32_t>(c - 'A' + 10);
            else fail("Invalid Unicode escape");
        }
        return value;
    }

    std::string parseString() {
        if (!consume('"')) fail("Missing opening quote");
        std::string result;
        while (position_ < input_.size()) {
            const unsigned char c =
                static_cast<unsigned char>(input_[position_++]);
            if (c == '"') return result;
            if (c < 0x20U) fail("Control character in string");
            if (c != '\\') {
                result.push_back(static_cast<char>(c));
                continue;
            }
            if (position_ >= input_.size()) fail("Truncated escape");
            const char escaped = input_[position_++];
            switch (escaped) {
                case '"': result.push_back('"'); break;
                case '\\': result.push_back('\\'); break;
                case '/': result.push_back('/'); break;
                case 'b': result.push_back('\b'); break;
                case 'f': result.push_back('\f'); break;
                case 'n': result.push_back('\n'); break;
                case 'r': result.push_back('\r'); break;
                case 't': result.push_back('\t'); break;
                case 'u': {
                    std::uint32_t codepoint = parseHex4();
                    if (codepoint >= 0xd800U && codepoint <= 0xdbffU) {
                        if (input_.compare(position_, 2, "\\u") != 0) {
                            fail("Missing low surrogate");
                        }
                        position_ += 2;
                        const std::uint32_t low = parseHex4();
                        if (low < 0xdc00U || low > 0xdfffU) {
                            fail("Invalid low surrogate");
                        }
                        codepoint = 0x10000U +
                            ((codepoint - 0xd800U) << 10U) + (low - 0xdc00U);
                    }
                    appendUtf8(result, codepoint);
                    break;
                }
                default: fail("Invalid string escape");
            }
        }
        fail("Unterminated string");
    }

    double parseNumber() {
        const std::size_t start = position_;
        if (input_[position_] == '-') ++position_;
        if (position_ >= input_.size()) fail("Truncated number");
        if (input_[position_] == '0') {
            ++position_;
        } else {
            if (input_[position_] < '1' || input_[position_] > '9') {
                fail("Invalid number");
            }
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
        }
        if (position_ < input_.size() && input_[position_] == '.') {
            ++position_;
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
        }
        if (position_ < input_.size() &&
            (input_[position_] == 'e' || input_[position_] == 'E')) {
            ++position_;
            if (position_ < input_.size() &&
                (input_[position_] == '+' || input_[position_] == '-')) {
                ++position_;
            }
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
        }
        return std::stod(input_.substr(start, position_ - start));
    }

    const std::string& input_;
    std::size_t position_ = 0;
};

const Json& objectField(const Json::Object& object, const std::string& key) {
    const auto found = object.find(key);
    if (found == object.end()) {
        throw std::runtime_error("Schedule JSON is missing field: " + key);
    }
    return found->second;
}

std::int64_t parseKstSecond(const std::string& text) {
    if (text.size() < 19) {
        throw std::runtime_error("Invalid date/time: " + text);
    }
    std::tm value{};
    std::istringstream input(text.substr(0, 19));
    input >> std::get_time(&value, "%Y-%m-%d %H:%M:%S");
    if (!input) {
        throw std::runtime_error("Invalid date/time: " + text);
    }
    const std::time_t localAsUtc = timegm(&value);
    if (localAsUtc == static_cast<std::time_t>(-1)) {
        throw std::runtime_error("Date/time is outside supported range: " + text);
    }
    return static_cast<std::int64_t>(localAsUtc) - kSeoulUtcOffsetSeconds;
}

std::int64_t parseCsvTenths(const std::string& text) {
    if (text.size() < 19) {
        throw std::runtime_error("Invalid CSV timestamp: " + text);
    }
    std::string base = text.substr(0, 19);
    std::replace(base.begin(), base.end(), 'T', ' ');
    std::int64_t seconds = parseKstSecond(base);
    std::int64_t nanoseconds = 0;
    if (text.size() > 20 && text[19] == '.') {
        std::size_t position = 20;
        int digits = 0;
        while (position < text.size() && text[position] >= '0' &&
               text[position] <= '9' && digits < 9) {
            nanoseconds = nanoseconds * 10 + (text[position] - '0');
            ++position;
            ++digits;
        }
        while (digits++ < 9) nanoseconds *= 10;
    }
    std::int64_t tenths = (nanoseconds + 50000000LL) / 100000000LL;
    if (tenths == 10) {
        ++seconds;
        tenths = 0;
    }
    return seconds * 10 + tenths;
}

std::vector<Program> parseSchedule(const std::string& jsonText) {
    const Json root = JsonParser(jsonText).parse();
    const auto& object = root.object();
    const std::string resultCode = objectField(object, "ResultCode").string();
    if (resultCode != "1") {
        throw std::runtime_error("Schedule API ResultCode is " + resultCode);
    }

    std::vector<Program> programs;
    for (const Json& itemValue : objectField(object, "items").array()) {
        const auto& item = itemValue.object();
        Program program;
        program.startTenths =
            parseKstSecond(objectField(item, "StartTime").string()) * 10;
        const std::string durationText = objectField(item, "Duration").string();
        program.durationSeconds = std::stoll(durationText);
        if (program.durationSeconds <= 0) {
            throw std::runtime_error("Schedule contains a non-positive duration");
        }
        program.endTenths =
            program.startTenths + program.durationSeconds * 10;
        program.title = objectField(item, "ProgramItemName").string();
        program.id = objectField(item, "ProgramID").string();
        program.expectedBlockCount =
            program.durationSeconds * 10 >= 4
                ? static_cast<std::size_t>(program.durationSeconds * 10 - 3)
                : 0;
        programs.push_back(std::move(program));
    }
    if (programs.empty()) {
        throw std::runtime_error("Schedule API returned no items");
    }
    return programs;
}

std::vector<std::string> splitCsvLine(const std::string& line) {
    std::vector<std::string> values;
    std::size_t start = 0;
    while (true) {
        const std::size_t comma = line.find(',', start);
        if (comma == std::string::npos) {
            values.push_back(line.substr(start));
            break;
        }
        values.push_back(line.substr(start, comma - start));
        start = comma + 1;
    }
    return values;
}

std::vector<Momentary> loadMomentaries(
    const std::filesystem::path& directory,
    std::int64_t rangeStartTenths,
    std::int64_t rangeEndTenths) {
    if (!std::filesystem::is_directory(directory)) {
        throw std::runtime_error("Recordings directory does not exist: " +
                                 directory.string());
    }

    std::vector<std::filesystem::path> paths;
    for (const auto& entry : std::filesystem::directory_iterator(directory)) {
        if (!entry.is_regular_file()) continue;
        const std::string name = entry.path().filename().string();
        if (name.find("_mlkfs") != std::string::npos &&
            entry.path().extension() == ".csv") {
            paths.push_back(entry.path());
        }
    }
    std::sort(paths.begin(), paths.end());

    std::vector<Momentary> result;
    for (const auto& path : paths) {
        std::ifstream input(path);
        if (!input) {
            throw std::runtime_error("Could not open M-LKFS file: " +
                                     path.string());
        }
        std::string line;
        if (!std::getline(input, line)) continue;
        const auto header = splitCsvLine(line);
        const auto indexOf = [&](const std::string& name) {
            const auto found = std::find(header.begin(), header.end(), name);
            if (found == header.end()) {
                throw std::runtime_error(path.string() +
                                         " is missing CSV column " + name);
            }
            return static_cast<std::size_t>(found - header.begin());
        };
        const std::size_t startIndex = indexOf("start_time_kst");
        const std::size_t endIndex = indexOf("end_time_kst");
        const std::size_t startSampleIndex = indexOf("start_sample");
        const std::size_t endSampleIndex = indexOf("end_sample");
        const std::size_t valueIndex = indexOf("mlkfs");
        const std::size_t filterIndex = indexOf("filter");
        const std::size_t required =
            std::max({startIndex, endIndex, startSampleIndex, endSampleIndex,
                      valueIndex, filterIndex}) + 1;

        std::size_t lineNumber = 1;
        std::optional<std::int64_t> anchorTenths;
        std::uint64_t anchorSample = 0;
        while (std::getline(input, line)) {
            ++lineNumber;
            if (line.empty()) continue;
            const auto fields = splitCsvLine(line);
            if (fields.size() < required) {
                throw std::runtime_error(path.string() + ':' +
                    std::to_string(lineNumber) + " has too few columns");
            }
            Momentary block;
            const std::uint64_t startSample =
                std::stoull(fields[startSampleIndex]);
            const std::uint64_t endSample =
                std::stoull(fields[endSampleIndex]);
            if (!anchorTenths) {
                anchorTenths = parseCsvTenths(fields[startIndex]);
                anchorSample = startSample;
            }
            if (startSample < anchorSample ||
                (startSample - anchorSample) %
                        loudness::LKFS::kHopSamples != 0 ||
                endSample - startSample != loudness::LKFS::kWindowSamples) {
                throw std::runtime_error(
                    path.string() + ':' + std::to_string(lineNumber) +
                    " has invalid loudness sample indexes");
            }
            block.startTenths =
                *anchorTenths +
                static_cast<std::int64_t>(
                    (startSample - anchorSample) /
                    loudness::LKFS::kHopSamples);
            block.endTenths = block.startTenths + 4;
            if (block.endTenths <= rangeStartTenths ||
                block.startTenths >= rangeEndTenths) {
                continue;
            }
            block.value = std::stod(fields[valueIndex]);
            block.filter = fields[filterIndex];
            result.push_back(std::move(block));
        }
    }

    std::sort(result.begin(), result.end(),
              [](const Momentary& left, const Momentary& right) {
                  if (left.startTenths != right.startTenths) {
                      return left.startTenths < right.startTenths;
                  }
                  return left.endTenths < right.endTenths;
              });
    for (std::size_t i = 1; i < result.size(); ++i) {
        if (result[i - 1].startTenths == result[i].startTenths &&
            result[i - 1].endTenths == result[i].endTenths) {
            throw std::runtime_error(
                "Overlapping M-LKFS logs contain duplicate block at " +
                std::to_string(result[i].startTenths));
        }
    }
    if (!result.empty()) {
        const std::string& filter = result.front().filter;
        for (const Momentary& block : result) {
            if (block.filter != filter) {
                throw std::runtime_error(
                    "The report range contains mixed M-LKFS filter types (" +
                    filter + " and " + block.filter + ')');
            }
        }
    }
    return result;
}

std::size_t calculateLoudness(std::vector<Program>& programs,
                              const std::vector<Momentary>& blocks) {
    std::size_t incomplete = 0;
    for (Program& program : programs) {
        const auto first = std::lower_bound(
            blocks.begin(), blocks.end(), program.startTenths,
            [](const Momentary& block, std::int64_t start) {
                return block.startTenths < start;
            });
        std::vector<double> values;
        std::string filter;
        bool contiguous = true;
        for (auto current = first; current != blocks.end() &&
             current->startTenths < program.endTenths; ++current) {
            if (current->startTenths >= program.startTenths &&
                current->endTenths <= program.endTenths) {
                const std::int64_t expectedStart =
                    program.startTenths +
                    static_cast<std::int64_t>(values.size());
                if (current->startTenths != expectedStart ||
                    current->endTenths != current->startTenths + 4) {
                    contiguous = false;
                }
                if (filter.empty()) filter = current->filter;
                if (current->filter != filter) {
                    throw std::runtime_error(
                        "A programme contains mixed loudness filter types");
                }
                values.push_back(current->value);
            }
        }
        program.blockCount = values.size();
        if (!contiguous ||
            program.blockCount != program.expectedBlockCount) {
            ++incomplete;
            continue;
        }
        program.integratedLoudness =
            loudness::LKFS::integratedLoudness(values);
        if (!program.integratedLoudness) {
            ++incomplete;
        }
    }
    return incomplete;
}

std::tm seoulTmFromTenths(std::int64_t tenths) {
    const std::time_t shifted = static_cast<std::time_t>(
        tenths / 10 + kSeoulUtcOffsetSeconds);
    std::tm result{};
    gmtime_r(&shifted, &result);
    return result;
}

std::string timeOfDay(std::int64_t tenths) {
    const std::tm value = seoulTmFromTenths(tenths);
    std::ostringstream output;
    output << std::put_time(&value, "%H:%M:%S");
    return output.str();
}

std::string formatDuration(std::int64_t seconds) {
    const std::int64_t hours = seconds / 3600;
    const std::int64_t minutes = (seconds % 3600) / 60;
    const std::int64_t remainder = seconds % 60;
    std::ostringstream output;
    output << std::setw(2) << std::setfill('0') << hours << ':'
           << std::setw(2) << minutes << ':'
           << std::setw(2) << remainder;
    return output.str();
}

std::string csvQuote(const std::string& value) {
    if (value.find_first_of(",\"\r\n") == std::string::npos) return value;
    std::string result = "\"";
    for (char c : value) {
        if (c == '"') result += '"';
        result += c;
    }
    result += '"';
    return result;
}

void writeCsvReport(const std::filesystem::path& path,
                    const std::vector<Program>& programs) {
    std::ofstream output(path, std::ios::trunc);
    if (!output) {
        throw std::runtime_error("Could not create report: " + path.string());
    }
    output << "Start Time,End Time,Duration,ILKFS,Title,ID\n";
    for (const Program& program : programs) {
        output << timeOfDay(program.startTenths) << ','
               << timeOfDay(program.endTenths) << ','
               << formatDuration(program.durationSeconds) << ',';
        if (program.integratedLoudness) {
            output << std::setprecision(
                std::numeric_limits<double>::max_digits10)
                   << *program.integratedLoudness;
        }
        output << ',' << csvQuote(program.title) << ','
               << csvQuote(program.id) << '\n';
    }
    if (!output) {
        throw std::runtime_error("Failed while writing report: " + path.string());
    }
}

std::string xmlEscape(const std::string& value) {
    std::string result;
    result.reserve(value.size());
    for (unsigned char c : value) {
        switch (c) {
            case '&': result += "&amp;"; break;
            case '<': result += "&lt;"; break;
            case '>': result += "&gt;"; break;
            case '"': result += "&quot;"; break;
            case '\'': result += "&apos;"; break;
            default:
                if (c >= 0x20U || c == '\n' || c == '\r' || c == '\t') {
                    result.push_back(static_cast<char>(c));
                }
        }
    }
    return result;
}

std::uint32_t crc32(const std::string& data) {
    std::uint32_t crc = 0xffffffffU;
    for (unsigned char byte : data) {
        crc ^= byte;
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1U) ^
                  (0xedb88320U & static_cast<std::uint32_t>(
                      -static_cast<std::int32_t>(crc & 1U)));
        }
    }
    return ~crc;
}

void writeLe16(std::ostream& output, std::uint16_t value) {
    const std::array<char, 2> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU)};
    output.write(bytes.data(), bytes.size());
}

void writeLe32(std::ostream& output, std::uint32_t value) {
    const std::array<char, 4> bytes{
        static_cast<char>(value & 0xffU),
        static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU),
        static_cast<char>((value >> 24U) & 0xffU)};
    output.write(bytes.data(), bytes.size());
}

class ZipWriter {
public:
    explicit ZipWriter(const std::filesystem::path& path) : output_(path, std::ios::binary) {
        if (!output_) {
            throw std::runtime_error("Could not create XLSX: " + path.string());
        }
    }

    void add(const std::string& name, const std::string& data) {
        if (name.size() > std::numeric_limits<std::uint16_t>::max() ||
            data.size() > std::numeric_limits<std::uint32_t>::max()) {
            throw std::runtime_error("XLSX ZIP entry is too large");
        }
        Entry entry{name, crc32(data), static_cast<std::uint32_t>(data.size()),
                    static_cast<std::uint32_t>(output_.tellp())};
        writeLe32(output_, 0x04034b50U);
        writeLe16(output_, 20);
        writeLe16(output_, 0);
        writeLe16(output_, 0);
        writeLe16(output_, 0);
        writeLe16(output_, 33);
        writeLe32(output_, entry.crc);
        writeLe32(output_, entry.size);
        writeLe32(output_, entry.size);
        writeLe16(output_, static_cast<std::uint16_t>(name.size()));
        writeLe16(output_, 0);
        output_.write(name.data(), static_cast<std::streamsize>(name.size()));
        output_.write(data.data(), static_cast<std::streamsize>(data.size()));
        entries_.push_back(std::move(entry));
    }

    void close() {
        if (closed_) return;
        const std::uint32_t centralOffset =
            static_cast<std::uint32_t>(output_.tellp());
        for (const Entry& entry : entries_) {
            writeLe32(output_, 0x02014b50U);
            writeLe16(output_, 20);
            writeLe16(output_, 20);
            writeLe16(output_, 0);
            writeLe16(output_, 0);
            writeLe16(output_, 0);
            writeLe16(output_, 33);
            writeLe32(output_, entry.crc);
            writeLe32(output_, entry.size);
            writeLe32(output_, entry.size);
            writeLe16(output_, static_cast<std::uint16_t>(entry.name.size()));
            writeLe16(output_, 0);
            writeLe16(output_, 0);
            writeLe16(output_, 0);
            writeLe16(output_, 0);
            writeLe32(output_, 0);
            writeLe32(output_, entry.offset);
            output_.write(entry.name.data(),
                          static_cast<std::streamsize>(entry.name.size()));
        }
        const std::uint32_t centralSize =
            static_cast<std::uint32_t>(output_.tellp()) - centralOffset;
        writeLe32(output_, 0x06054b50U);
        writeLe16(output_, 0);
        writeLe16(output_, 0);
        writeLe16(output_, static_cast<std::uint16_t>(entries_.size()));
        writeLe16(output_, static_cast<std::uint16_t>(entries_.size()));
        writeLe32(output_, centralSize);
        writeLe32(output_, centralOffset);
        writeLe16(output_, 0);
        output_.flush();
        if (!output_) throw std::runtime_error("Failed to finish XLSX");
        closed_ = true;
    }

    ~ZipWriter() {
        try { close(); } catch (...) {}
    }

private:
    struct Entry {
        std::string name;
        std::uint32_t crc;
        std::uint32_t size;
        std::uint32_t offset;
    };
    std::ofstream output_;
    std::vector<Entry> entries_;
    bool closed_ = false;
};

std::string inlineCell(const std::string& reference,
                       const std::string& value,
                       int style = 0) {
    std::ostringstream output;
    output << "<c r=\"" << reference << "\"";
    if (style != 0) output << " s=\"" << style << "\"";
    output << " t=\"inlineStr\"><is><t xml:space=\"preserve\">"
           << xmlEscape(value) << "</t></is></c>";
    return output.str();
}

void writeXlsxReport(const std::filesystem::path& path,
                     const std::vector<Program>& programs) {
    const std::string contentTypes =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
        "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
        "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
        "</Types>";
    const std::string rootRels =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>"
        "</Relationships>";
    const std::string workbook =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" "
        "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
        "<sheets><sheet name=\"Loudness Report\" sheetId=\"1\" r:id=\"rId1\"/></sheets>"
        "</workbook>";
    const std::string workbookRels =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
        "</Relationships>";
    const std::string styles =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
        "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>"
        "<font><b/><color rgb=\"FFFFFFFF\"/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>"
        "<fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill>"
        "<fill><patternFill patternType=\"gray125\"/></fill>"
        "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF1F4E78\"/><bgColor indexed=\"64\"/></patternFill></fill></fills>"
        "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
        "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
        "<cellXfs count=\"4\">"
        "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
        "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\"><alignment horizontal=\"center\"/></xf>"
        "<xf numFmtId=\"2\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>"
        "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"><alignment wrapText=\"1\" vertical=\"top\"/></xf>"
        "</cellXfs>"
        "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>"
        "</styleSheet>";

    std::ostringstream sheet;
    sheet << "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
          << "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
          << "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>"
          << "<cols><col min=\"1\" max=\"3\" width=\"13\" customWidth=\"1\"/>"
          << "<col min=\"4\" max=\"4\" width=\"12\" customWidth=\"1\"/>"
          << "<col min=\"5\" max=\"5\" width=\"80\" customWidth=\"1\"/>"
          << "<col min=\"6\" max=\"6\" width=\"18\" customWidth=\"1\"/></cols>"
          << "<sheetData><row r=\"1\">";
    const std::array<const char*, 6> headers{
        "Start Time", "End Time", "Duration", "ILKFS", "Title", "ID"};
    for (std::size_t column = 0; column < headers.size(); ++column) {
        const std::string reference(1, static_cast<char>('A' + column));
        sheet << inlineCell(reference + "1", headers[column], 1);
    }
    sheet << "</row>";
    for (std::size_t index = 0; index < programs.size(); ++index) {
        const Program& program = programs[index];
        const std::size_t row = index + 2;
        const std::string rowText = std::to_string(row);
        sheet << "<row r=\"" << row << "\">"
              << inlineCell("A" + rowText, timeOfDay(program.startTenths))
              << inlineCell("B" + rowText, timeOfDay(program.endTenths))
              << inlineCell("C" + rowText,
                            formatDuration(program.durationSeconds));
        if (program.integratedLoudness) {
            sheet << "<c r=\"D" << row << "\" s=\"2\"><v>"
                  << std::setprecision(
                         std::numeric_limits<double>::max_digits10)
                  << *program.integratedLoudness << "</v></c>";
        }
        sheet << inlineCell("E" + rowText, program.title, 3)
              << inlineCell("F" + rowText, program.id)
              << "</row>";
    }
    sheet << "</sheetData><autoFilter ref=\"A1:F" << programs.size() + 1
          << "\"/><pageMargins left=\"0.25\" right=\"0.25\" top=\"0.5\" bottom=\"0.5\" header=\"0.2\" footer=\"0.2\"/>"
          << "</worksheet>";

    ZipWriter zip(path);
    zip.add("[Content_Types].xml", contentTypes);
    zip.add("_rels/.rels", rootRels);
    zip.add("xl/workbook.xml", workbook);
    zip.add("xl/_rels/workbook.xml.rels", workbookRels);
    zip.add("xl/styles.xml", styles);
    zip.add("xl/worksheets/sheet1.xml", sheet.str());
    zip.close();
}

int run(const Options& options) {
    if (!options.audioOnly &&
        std::filesystem::exists(options.output) && !options.force) {
        throw std::runtime_error(
            "Output already exists; choose another path or use --force: " +
            options.output.string());
    }
    if (!options.audioOnly && !options.output.parent_path().empty()) {
        std::error_code error;
        std::filesystem::create_directories(options.output.parent_path(), error);
        if (error) {
            throw std::runtime_error("Could not create report directory: " +
                                     error.message());
        }
    }

    std::string scheduleText;
    if (!options.scheduleJson.empty()) {
        scheduleText = readFile(options.scheduleJson);
        std::cout << "Reading schedule JSON: " << options.scheduleJson << '\n';
    } else {
        const std::string path =
            "/cms/api/frmtn/dailyInfo.json?date=" + options.date +
            "&UHDSchedule=False";
        std::cout << "Fetching schedule: http://" << options.apiHost << ':'
                  << options.apiPort << path << '\n';
        scheduleText = httpGet(options.apiHost, options.apiPort, path);
    }

    if (!options.scheduleOutput.empty()) {
        writeFile(options.scheduleOutput, scheduleText);
        std::cout << "Saved schedule JSON: "
                  << options.scheduleOutput << '\n';
    }

    std::vector<Program> programs = parseSchedule(scheduleText);
    if (options.audioOnly) {
        std::vector<program_audio::Clip> clips;
        clips.reserve(programs.size());
        for (const Program& program : programs) {
            clips.push_back(program_audio::Clip{
                program.startTenths,
                program.durationSeconds,
                program.title,
                program.id,
            });
        }
        const program_audio::Result result =
            program_audio::exportClips(
                options.recordingsDirectory,
                options.audioOutputDirectory,
                clips,
                options.force);
        std::cout << "Created programme audio: "
                  << options.audioOutputDirectory << " ("
                  << result.created << " files for "
                  << programs.size() << " schedule items)\n";
        if (!result.warnings.empty()) {
            std::cerr << "WARNING: " << result.warnings.size()
                      << " programme audio files could not be created:\n";
            for (const std::string& warning : result.warnings) {
                std::cerr << "  " << warning << '\n';
            }
            return 2;
        }
        return 0;
    }
    const std::int64_t rangeStart = programs.front().startTenths;
    const std::int64_t rangeEnd = std::max_element(
        programs.begin(), programs.end(),
        [](const Program& left, const Program& right) {
            return left.endTenths < right.endTenths;
        })->endTenths;
    const std::vector<Momentary> blocks =
        loadMomentaries(options.recordingsDirectory, rangeStart, rangeEnd);
    if (blocks.empty()) {
        throw std::runtime_error("No M-LKFS blocks cover the schedule");
    }

    const std::size_t incomplete = calculateLoudness(programs, blocks);
    if (toLower(options.output.extension().string()) == ".csv") {
        writeCsvReport(options.output, programs);
    } else if (toLower(options.output.extension().string()) == ".xlsx") {
        writeXlsxReport(options.output, programs);
    } else {
        throw std::invalid_argument("Output extension must be .xlsx or .csv");
    }

    program_audio::Result audioResult;
    if (options.createAudio) {
        std::vector<program_audio::Clip> clips;
        clips.reserve(programs.size());
        for (const Program& program : programs) {
            clips.push_back(program_audio::Clip{
                program.startTenths,
                program.durationSeconds,
                program.title,
                program.id,
            });
        }
        audioResult = program_audio::exportClips(
            options.recordingsDirectory,
            options.audioOutputDirectory,
            clips,
            options.force);
    }

    std::cout << "Created report: " << options.output << '\n'
              << "Schedule items: " << programs.size() << '\n'
              << "M-LKFS blocks loaded: " << blocks.size() << '\n';
    if (options.createAudio) {
        std::cout << "Created programme audio: "
                  << options.audioOutputDirectory << " ("
                  << audioResult.created << " files for "
                  << programs.size() << " schedule items)\n";
    }
    if (incomplete != 0 || !audioResult.warnings.empty()) {
        if (incomplete != 0) {
            std::cerr << "WARNING: " << incomplete
                      << " schedule items have incomplete or silent M-LKFS data; "
                         "their ILKFS cells are blank.\n";
        }
        for (const Program& program : programs) {
            if (!program.integratedLoudness) {
                std::cerr << "  " << timeOfDay(program.startTenths) << ' '
                          << program.title << ": blocks " << program.blockCount
                          << '/' << program.expectedBlockCount << '\n';
            }
        }
        if (!audioResult.warnings.empty()) {
            std::cerr << "WARNING: " << audioResult.warnings.size()
                      << " programme audio files could not be created:\n";
            for (const std::string& warning : audioResult.warnings) {
                std::cerr << "  " << warning << '\n';
            }
        }
        return 2;
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const Options options = parseOptions(argc, argv);
        if (options.showHelp) {
            printUsage(argv[0]);
            return 0;
        }
        return run(options);
    } catch (const std::exception& exception) {
        std::cerr << "Error: " << exception.what() << '\n';
        return 1;
    }
}
