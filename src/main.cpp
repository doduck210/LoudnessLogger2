#include "DeckLinkAPI.h"
#include "WavSegmentWriter.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <getopt.h>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

volatile std::sig_atomic_t g_stopRequested = 0;
constexpr std::uint16_t kAudioChannels = 2;
constexpr std::uint16_t kAudioBitsPerSample = 32;

void handleSignal(int) {
    g_stopRequested = 1;
}

template <typename T>
class ComPtr {
public:
    ComPtr() = default;
    explicit ComPtr(T* pointer) : pointer_(pointer) {}
    ~ComPtr() { reset(); }

    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : pointer_(other.pointer_) {
        other.pointer_ = nullptr;
    }
    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            reset();
            pointer_ = other.pointer_;
            other.pointer_ = nullptr;
        }
        return *this;
    }

    T* get() const { return pointer_; }
    T** put() {
        reset();
        return &pointer_;
    }
    T* operator->() const { return pointer_; }
    explicit operator bool() const { return pointer_ != nullptr; }
    void reset(T* pointer = nullptr) {
        if (pointer_) {
            pointer_->Release();
        }
        pointer_ = pointer;
    }

private:
    T* pointer_ = nullptr;
};

struct Options {
    int deviceIndex = 0;
    int modeIndex = -1;
    std::string outputDirectory = "./recordings";
    std::uint32_t segmentMinutes = 60;
    std::size_t queueMiB = 64;
    loudness::LKFS::FilterType loudnessFilter =
        loudness::LKFS::FilterType::Rbj;
    bool listDevices = false;
    bool listModes = false;
    bool showHelp = false;
};

unsigned long parseUnsigned(const char* text, const char* optionName) {
    std::size_t parsed = 0;
    const std::string value(text);
    const unsigned long result = std::stoul(value, &parsed, 10);
    if (parsed != value.size()) {
        throw std::invalid_argument(std::string("Invalid value for ") + optionName + ": " + value);
    }
    return result;
}

loudness::LKFS::FilterType parseLoudnessFilter(const char* text) {
    const std::string value(text);
    if (value == "rbj") {
        return loudness::LKFS::FilterType::Rbj;
    }
    if (value == "deman") {
        return loudness::LKFS::FilterType::DeMan;
    }
    throw std::invalid_argument(
        "Invalid value for --lkfs-filter: " + value + " (use rbj or deman)");
}

void printUsage(const char* program) {
    std::cout
        << "Usage: " << program << " [options]\n\n"
        << "  -d, --device INDEX          Capture-capable DeckLink index (default: 0)\n"
        << "  -m, --mode INDEX            Fixed display-mode index (default: auto detect)\n"
        << "  -o, --output DIRECTORY      WAV output directory (default: ./recordings)\n"
        << "  -s, --segment-minutes N     Local-clock aligned segment length (default: 60)\n"
        << "  -q, --queue-mib N           Writer queue capacity (default: 64 MiB)\n"
        << "      --lkfs-filter NAME      Loudness filter: rbj or deman (default: rbj)\n"
        << "      --list-devices          List capture-capable DeckLink devices\n"
        << "      --list-modes            List modes for the selected device\n"
        << "  -h, --help                  Show this help\n\n"
        << "Audio format is fixed to SDI channels 1-2, 48 kHz, 32-bit PCM.\n\n"
        << "Example:\n"
        << "  " << program << " -d 0 -o /mnt/raid/recording/SBS_HD -s 60\n";
}

Options parseOptions(int argc, char** argv) {
    Options options;
    constexpr option longOptions[] = {
        {"device", required_argument, nullptr, 'd'},
        {"mode", required_argument, nullptr, 'm'},
        {"output", required_argument, nullptr, 'o'},
        {"segment-minutes", required_argument, nullptr, 's'},
        {"queue-mib", required_argument, nullptr, 'q'},
        {"lkfs-filter", required_argument, nullptr, 1002},
        {"list-devices", no_argument, nullptr, 1000},
        {"list-modes", no_argument, nullptr, 1001},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };

    while (true) {
        const int choice = getopt_long(argc, argv, "d:m:o:s:q:h", longOptions, nullptr);
        if (choice == -1) {
            break;
        }
        switch (choice) {
            case 'd': options.deviceIndex = static_cast<int>(parseUnsigned(optarg, "--device")); break;
            case 'm': options.modeIndex = static_cast<int>(parseUnsigned(optarg, "--mode")); break;
            case 'o': options.outputDirectory = optarg; break;
            case 's': options.segmentMinutes = static_cast<std::uint32_t>(parseUnsigned(optarg, "--segment-minutes")); break;
            case 'q': options.queueMiB = static_cast<std::size_t>(parseUnsigned(optarg, "--queue-mib")); break;
            case 1000: options.listDevices = true; break;
            case 1001: options.listModes = true; break;
            case 1002: options.loudnessFilter = parseLoudnessFilter(optarg); break;
            case 'h': options.showHelp = true; break;
            default: throw std::invalid_argument("Invalid command-line option");
        }
    }
    if (optind != argc) {
        throw std::invalid_argument(std::string("Unexpected argument: ") + argv[optind]);
    }
    return options;
}

bool isCaptureDevice(IDeckLink* device) {
    ComPtr<IDeckLinkProfileAttributes> attributes;
    if (device->QueryInterface(IID_IDeckLinkProfileAttributes,
                               reinterpret_cast<void**>(attributes.put())) != S_OK) {
        return false;
    }
    std::int64_t support = 0;
    return attributes->GetInt(BMDDeckLinkVideoIOSupport, &support) == S_OK &&
           (support & bmdDeviceSupportsCapture) != 0;
}

std::string deviceName(IDeckLink* device) {
    const char* rawName = nullptr;
    if (device->GetDisplayName(&rawName) != S_OK || rawName == nullptr) {
        return "Unknown DeckLink";
    }
    const std::string name(rawName);
    std::free(const_cast<char*>(rawName));
    return name;
}

void listDevices() {
    ComPtr<IDeckLinkIterator> iterator(CreateDeckLinkIteratorInstance());
    if (!iterator) {
        throw std::runtime_error("DeckLink driver is not installed or could not be loaded");
    }

    int captureIndex = 0;
    IDeckLink* rawDevice = nullptr;
    while (iterator->Next(&rawDevice) == S_OK) {
        ComPtr<IDeckLink> device(rawDevice);
        rawDevice = nullptr;
        if (!isCaptureDevice(device.get())) {
            continue;
        }
        std::cout << '[' << captureIndex++ << "] " << deviceName(device.get()) << '\n';
    }
    if (captureIndex == 0) {
        std::cout << "No capture-capable DeckLink devices found\n";
    }
}

ComPtr<IDeckLink> selectedDevice(int selectedIndex) {
    ComPtr<IDeckLinkIterator> iterator(CreateDeckLinkIteratorInstance());
    if (!iterator) {
        throw std::runtime_error("DeckLink driver is not installed or could not be loaded");
    }

    int captureIndex = 0;
    IDeckLink* rawDevice = nullptr;
    while (iterator->Next(&rawDevice) == S_OK) {
        ComPtr<IDeckLink> device(rawDevice);
        rawDevice = nullptr;
        if (!isCaptureDevice(device.get())) {
            continue;
        }
        if (captureIndex++ == selectedIndex) {
            return device;
        }
    }
    throw std::runtime_error("Capture-capable DeckLink device index not found: " +
                             std::to_string(selectedIndex));
}

void listModes(IDeckLink* device) {
    ComPtr<IDeckLinkInput> input;
    if (device->QueryInterface(IID_IDeckLinkInput,
                               reinterpret_cast<void**>(input.put())) != S_OK) {
        throw std::runtime_error("Selected DeckLink has no input interface");
    }
    ComPtr<IDeckLinkDisplayModeIterator> iterator;
    if (input->GetDisplayModeIterator(iterator.put()) != S_OK) {
        throw std::runtime_error("Could not enumerate DeckLink display modes");
    }

    int index = 0;
    IDeckLinkDisplayMode* rawMode = nullptr;
    while (iterator->Next(&rawMode) == S_OK) {
        ComPtr<IDeckLinkDisplayMode> mode(rawMode);
        rawMode = nullptr;
        const char* rawName = nullptr;
        std::string name = "Unknown mode";
        if (mode->GetName(&rawName) == S_OK && rawName != nullptr) {
            name = rawName;
            std::free(const_cast<char*>(rawName));
        }
        BMDTimeValue frameDuration = 0;
        BMDTimeScale timeScale = 0;
        mode->GetFrameRate(&frameDuration, &timeScale);
        const double fps = frameDuration == 0 ? 0.0 :
            static_cast<double>(timeScale) / static_cast<double>(frameDuration);
        std::cout << '[' << index++ << "] " << name << " ("
                  << mode->GetWidth() << 'x' << mode->GetHeight() << ", "
                  << fps << " fps)\n";
    }
}

ComPtr<IDeckLinkDisplayMode> selectedMode(IDeckLinkInput* input, int modeIndex) {
    ComPtr<IDeckLinkDisplayMode> mode;
    if (modeIndex < 0) {
        if (input->GetDisplayMode(bmdModeHD1080i5994, mode.put()) == S_OK) {
            return mode;
        }
    }

    ComPtr<IDeckLinkDisplayModeIterator> iterator;
    if (input->GetDisplayModeIterator(iterator.put()) != S_OK) {
        throw std::runtime_error("Could not enumerate DeckLink display modes");
    }
    int index = modeIndex < 0 ? 0 : modeIndex;
    IDeckLinkDisplayMode* rawMode = nullptr;
    while (iterator->Next(&rawMode) == S_OK) {
        ComPtr<IDeckLinkDisplayMode> candidate(rawMode);
        rawMode = nullptr;
        if (index-- == 0) {
            return candidate;
        }
    }
    throw std::runtime_error("DeckLink display mode index not found: " +
                             std::to_string(modeIndex));
}

bool supportsFormatDetection(IDeckLink* device) {
    ComPtr<IDeckLinkProfileAttributes> attributes;
    if (device->QueryInterface(IID_IDeckLinkProfileAttributes,
                               reinterpret_cast<void**>(attributes.put())) != S_OK) {
        return false;
    }
    bool supported = false;
    return attributes->GetFlag(BMDDeckLinkSupportsInputFormatDetection, &supported) == S_OK &&
           supported;
}

class CaptureCallback final : public IDeckLinkInputCallback {
public:
    CaptureCallback(IDeckLinkInput* input,
                    WavSegmentWriter& writer,
                    BMDVideoInputFlags inputFlags)
        : input_(input), writer_(writer), inputFlags_(inputFlags) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* output) override {
        if (output == nullptr) {
            return E_INVALIDARG;
        }
        const REFIID unknownIid = {
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
        };
        const bool isUnknown = std::memcmp(&iid, &unknownIid, sizeof(REFIID)) == 0;
        const bool isInputCallback =
            std::memcmp(&iid, &IID_IDeckLinkInputCallback, sizeof(REFIID)) == 0;
        if (isUnknown || isInputCallback) {
            *output = static_cast<IDeckLinkInputCallback*>(this);
            AddRef();
            return S_OK;
        }
        *output = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++referenceCount_;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG count = --referenceCount_;
        if (count == 0) {
            delete this;
        }
        return count;
    }

    HRESULT STDMETHODCALLTYPE VideoInputFrameArrived(
        IDeckLinkVideoInputFrame* videoFrame,
        IDeckLinkAudioInputPacket* audioPacket) override {
        if (videoFrame && (videoFrame->GetFlags() & bmdFrameHasNoInputSource) == 0) {
            validVideoFrames_.fetch_add(1);
        }
        if (!audioPacket) {
            return S_OK;
        }

        void* bytes = nullptr;
        if (audioPacket->GetBytes(&bytes) != S_OK || bytes == nullptr) {
            packetErrors_.fetch_add(1);
            return S_OK;
        }
        const long frameCount = audioPacket->GetSampleFrameCount();
        if (frameCount <= 0 ||
            static_cast<unsigned long>(frameCount) >
                std::numeric_limits<std::uint32_t>::max()) {
            packetErrors_.fetch_add(1);
            return S_OK;
        }

        BMDTimeValue packetTime = 0;
        const bool packetTimeValid =
            audioPacket->GetPacketTime(&packetTime, 48000) == S_OK;
        writer_.enqueue(bytes, static_cast<std::uint32_t>(frameCount),
                        packetTime, packetTimeValid,
                        std::chrono::system_clock::now());
        audioPackets_.fetch_add(1);
        lastAudioPacketNs_.store(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE VideoInputFormatChanged(
        BMDVideoInputFormatChangedEvents events,
        IDeckLinkDisplayMode* mode,
        BMDDetectedVideoInputFormatFlags formatFlags) override {
        if (!mode || (inputFlags_ & bmdVideoInputEnableFormatDetection) == 0) {
            return S_OK;
        }
        std::lock_guard<std::mutex> lock(formatMutex_);

        BMDPixelFormat pixelFormat = pixelFormat_;
        if (events & bmdVideoInputColorspaceChanged) {
            if (formatFlags & bmdDetectedVideoInputRGB444) {
                pixelFormat = bmdFormat10BitRGB;
            } else if (formatFlags & bmdDetectedVideoInputYCbCr422) {
                pixelFormat = bmdFormat8BitYUV;
            }
        }

        if ((events & bmdVideoInputDisplayModeChanged) || pixelFormat != pixelFormat_) {
            input_->StopStreams();
            if (input_->EnableVideoInput(mode->GetDisplayMode(), pixelFormat,
                                         inputFlags_) != S_OK ||
                input_->StartStreams() != S_OK) {
                formatChangeFailed_.store(true);
                return E_FAIL;
            }
            pixelFormat_ = pixelFormat;
            std::cerr << "Detected SDI video format change; capture stream restarted\n";
        }
        return S_OK;
    }

    bool formatChangeFailed() const { return formatChangeFailed_.load(); }
    std::uint64_t audioPackets() const { return audioPackets_.load(); }
    std::uint64_t packetErrors() const { return packetErrors_.load(); }
    std::int64_t lastAudioPacketNs() const { return lastAudioPacketNs_.load(); }

private:
    std::atomic<ULONG> referenceCount_{1};
    IDeckLinkInput* input_;
    WavSegmentWriter& writer_;
    BMDVideoInputFlags inputFlags_;
    BMDPixelFormat pixelFormat_ = bmdFormat8BitYUV;
    std::mutex formatMutex_;
    std::atomic<bool> formatChangeFailed_{false};
    std::atomic<std::uint64_t> validVideoFrames_{0};
    std::atomic<std::uint64_t> audioPackets_{0};
    std::atomic<std::uint64_t> packetErrors_{0};
    std::atomic<std::int64_t> lastAudioPacketNs_{0};
};

int run(const Options& options) {
    if (options.listDevices) {
        listDevices();
        return 0;
    }

    ComPtr<IDeckLink> device = selectedDevice(options.deviceIndex);
    std::cout << "Selected DeckLink: " << deviceName(device.get()) << '\n';

    if (options.listModes) {
        listModes(device.get());
        return 0;
    }

    WavSegmentWriter::Config writerConfig;
    writerConfig.outputDirectory = options.outputDirectory;
    writerConfig.channels = kAudioChannels;
    writerConfig.bitsPerSample = kAudioBitsPerSample;
    writerConfig.segmentMinutes = options.segmentMinutes;
    writerConfig.maxQueueBytes = options.queueMiB * 1024U * 1024U;
    writerConfig.loudnessFilter = options.loudnessFilter;

    std::string validationError;
    if (!WavSegmentWriter::validateConfig(writerConfig, validationError)) {
        throw std::invalid_argument(validationError);
    }

    ComPtr<IDeckLinkInput> input;
    if (device->QueryInterface(IID_IDeckLinkInput,
                               reinterpret_cast<void**>(input.put())) != S_OK) {
        throw std::runtime_error("Selected DeckLink has no input interface");
    }
    ComPtr<IDeckLinkDisplayMode> mode = selectedMode(input.get(), options.modeIndex);

    BMDVideoInputFlags inputFlags = bmdVideoInputFlagDefault;
    if (options.modeIndex < 0 && supportsFormatDetection(device.get())) {
        inputFlags = static_cast<BMDVideoInputFlags>(
            inputFlags | bmdVideoInputEnableFormatDetection);
        std::cout << "DeckLink input format detection enabled\n";
    } else if (options.modeIndex < 0) {
        std::cout << "Format detection is unavailable; using the initial video mode\n";
    }

    WavSegmentWriter writer(writerConfig);
    std::string writerError;
    if (!writer.start(writerError)) {
        throw std::runtime_error(writerError);
    }

    CaptureCallback* callback = new CaptureCallback(input.get(), writer, inputFlags);
    bool callbackRegistered = false;
    bool videoEnabled = false;
    bool audioEnabled = false;
    bool streamsStarted = false;
    std::uint64_t finalAudioPackets = 0;
    std::uint64_t finalPacketErrors = 0;

    auto cleanup = [&]() {
        if (streamsStarted) input->StopStreams();
        if (audioEnabled) input->DisableAudioInput();
        if (videoEnabled) input->DisableVideoInput();
        if (callbackRegistered) input->SetCallback(nullptr);
        finalAudioPackets = callback->audioPackets();
        finalPacketErrors = callback->packetErrors();
        callback->Release();
        writer.stop();
    };

    if (input->SetCallback(callback) != S_OK) {
        cleanup();
        throw std::runtime_error("Could not register DeckLink input callback");
    }
    callbackRegistered = true;

    if (input->EnableVideoInput(mode->GetDisplayMode(), bmdFormat8BitYUV,
                                inputFlags) != S_OK) {
        cleanup();
        throw std::runtime_error("Could not enable DeckLink video input; the device may be in use");
    }
    videoEnabled = true;

    if (input->EnableAudioInput(bmdAudioSampleRate48kHz,
                                bmdAudioSampleType32bitInteger,
                                kAudioChannels) != S_OK) {
        cleanup();
        throw std::runtime_error("Could not enable DeckLink audio input");
    }
    audioEnabled = true;

    if (input->StartStreams() != S_OK) {
        cleanup();
        throw std::runtime_error("Could not start DeckLink input streams");
    }
    streamsStarted = true;

    std::cout << "Recording SDI channels 1-2, 48 kHz, 32-bit PCM to "
              << options.outputDirectory << '\n'
              << "Writing hourly M-LKFS CSV logs using "
              << (options.loudnessFilter == loudness::LKFS::FilterType::Rbj
                      ? "RBJ" : "DeMan")
              << " K-weighting\n"
              << "Press Ctrl+C to stop.\n";

    std::uint64_t previousDropped = 0;
    constexpr std::int64_t kNanosecondsPerSecond = 1000000000LL;
    constexpr std::int64_t kNoAudioWarningNs = 5LL * kNanosecondsPerSecond;
    constexpr std::int64_t kWarningRepeatNs = 30LL * kNanosecondsPerSecond;
    const std::int64_t captureStartedNs =
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
    std::int64_t lastNoAudioWarningNs = 0;
    bool noAudioWarningActive = false;
    int result = 0;
    while (!g_stopRequested) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (writer.hasFatalError()) {
            std::cerr << "Writer failure: " << writer.fatalError() << '\n';
            result = 1;
            break;
        }
        if (callback->formatChangeFailed()) {
            std::cerr << "DeckLink format-change restart failed\n";
            result = 1;
            break;
        }

        const std::int64_t nowNs =
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
        const std::int64_t lastPacketNs = callback->lastAudioPacketNs();
        const std::int64_t audioReferenceNs =
            lastPacketNs > 0 ? lastPacketNs : captureStartedNs;
        const std::int64_t noAudioDurationNs = nowNs - audioReferenceNs;

        if (noAudioDurationNs >= kNoAudioWarningNs) {
            if (!noAudioWarningActive ||
                nowNs - lastNoAudioWarningNs >= kWarningRepeatNs) {
                std::cerr << "WARNING: No DeckLink audio packets received for "
                          << noAudioDurationNs / kNanosecondsPerSecond
                          << " seconds; recording is waiting for input.\n";
                lastNoAudioWarningNs = nowNs;
            }
            noAudioWarningActive = true;
        } else if (noAudioWarningActive && lastPacketNs > 0) {
            std::cerr << "INFO: DeckLink audio packets resumed.\n";
            noAudioWarningActive = false;
        }

        const auto currentStats = writer.stats();
        if (currentStats.droppedChunks != previousDropped) {
            std::cerr << "Writer queue overflow: dropped chunks="
                      << currentStats.droppedChunks << ", sample frames="
                      << currentStats.droppedSampleFrames << '\n';
            previousDropped = currentStats.droppedChunks;
        }
    }

    cleanup();
    const auto finalStats = writer.stats();
    std::cout << "Stopped. audio_packets=" << finalAudioPackets
              << " packet_errors=" << finalPacketErrors
              << " written_frames=" << finalStats.writtenSampleFrames
              << " dropped_frames=" << finalStats.droppedSampleFrames
              << " inserted_silence_frames=" << finalStats.insertedSilentFrames
              << '\n';
    return result;
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT, handleSignal);
    std::signal(SIGTERM, handleSignal);
    std::signal(SIGHUP, handleSignal);

    try {
        const Options options = parseOptions(argc, argv);
        if (options.showHelp) {
            printUsage(argv[0]);
            return 0;
        }
        return run(options);
    } catch (const std::exception& exception) {
        std::cerr << "Error: " << exception.what() << '\n';
        printUsage(argv[0]);
        return 1;
    }
}
