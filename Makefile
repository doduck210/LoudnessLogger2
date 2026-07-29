CXX ?= g++

RECORDER_TARGET := decklink_pcm_recorder
REPORT_TARGET := loudness_report
TARGETS := $(RECORDER_TARGET) $(REPORT_TARGET)

DECKLINK_DIR := third_party/decklink
RECORDER_SOURCES := \
	src/main.cpp \
	src/WavSegmentWriter.cpp \
	$(DECKLINK_DIR)/src/DeckLinkAPIDispatch.cpp
REPORT_SOURCES := src/report_main.cpp src/ProgramAudioExporter.cpp
HEADERS := $(wildcard include/*.h $(DECKLINK_DIR)/include/*.h)

CPPFLAGS += -Iinclude -I$(DECKLINK_DIR)/include
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra -Wpedantic -Wno-multichar
LDLIBS += -ldl -pthread

.PHONY: all clean

all: $(TARGETS)

$(RECORDER_TARGET): $(RECORDER_SOURCES) $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(RECORDER_SOURCES) -o $@ $(LDFLAGS) $(LDLIBS)

$(REPORT_TARGET): $(REPORT_SOURCES) $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(REPORT_SOURCES) -o $@ $(LDFLAGS)

clean:
	rm -f $(TARGETS)
