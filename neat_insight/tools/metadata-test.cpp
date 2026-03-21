#include <iostream>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#include <random>
#include <cstring>
#include <cstdlib>
#include <ctime>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

constexpr int FRAME_WIDTH = 1280;
constexpr int FRAME_HEIGHT = 720;
constexpr double FRAME_INTERVAL_SEC = 1.0 / 30.0;

std::random_device rd;
std::mt19937 rng(rd());
std::uniform_real_distribution<double> conf_car(0.7, 0.99);
std::uniform_real_distribution<double> conf_person(0.85, 0.99);

json generate_object_detection() {
    std::vector<std::vector<int>> car_locations = {
        {100, 100, 100, 80}, {1080, 100, 100, 80}, {100, 540, 100, 80}, {1080, 540, 100, 80}
    };
    std::vector<std::vector<int>> person_boxes = {
        {200, 100, 60, 120}, {1020, 100, 60, 120}, {200, 500, 60, 120}, {1020, 500, 60, 120}
    };

    auto car_box = car_locations[rng() % car_locations.size()];
    auto person_box = person_boxes[rng() % person_boxes.size()];

    json obj = {
        {"type", "object-detection"},
        {"timestamp", std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count()},
        {"data", {
            {"objects", {
                {
                    {"id", "obj_1"},
                    {"label", "car"},
                    {"confidence", std::round(conf_car(rng) * 100) / 100},
                    {"bbox", car_box}
                },
                {
                    {"id", "obj_2"},
                    {"label", "person"},
                    {"confidence", std::round(conf_person(rng) * 100) / 100},
                    {"bbox", person_box}
                }
            }}
        }}
    };

    return obj;
}

void send_metadata(int port, bool pad_mode) {
    constexpr size_t PADDED_UDP_SIZE = 64000;

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        perror("socket creation failed");
        exit(EXIT_FAILURE);
    }

    sockaddr_in servaddr{};
    servaddr.sin_family = AF_INET;
    servaddr.sin_port = htons(port);
    servaddr.sin_addr.s_addr = inet_addr("127.0.0.1");

    std::vector<char> buffer;

    if (pad_mode)
        buffer.resize(PADDED_UDP_SIZE, 0); // preallocated 32KB

    while (true) {
        auto start = std::chrono::steady_clock::now();

        json payload = generate_object_detection();
        std::string message = payload.dump();

        ssize_t sent = 0;
        if (pad_mode) {
            if (message.size() > PADDED_UDP_SIZE) {
                std::cerr << "⚠️ Payload too large for 32KB! Truncating.\n";
                message = message.substr(0, PADDED_UDP_SIZE);
            }

            std::fill(buffer.begin(), buffer.end(), 0);
            std::memcpy(buffer.data(), message.data(), message.size());

            sent = sendto(sock, buffer.data(), buffer.size(), 0,
                          (const struct sockaddr *)&servaddr, sizeof(servaddr));
        } else {
            sent = sendto(sock, message.data(), message.size(), 0,
                          (const struct sockaddr *)&servaddr, sizeof(servaddr));
        }

        if (sent >= 0) {
            std::cout << "📤 Sent " << (pad_mode ? "padded " : "")
                      << "UDP (" << sent << " bytes) to 127.0.0.1:" << port << std::endl;
        }

        auto end = std::chrono::steady_clock::now();
        std::chrono::duration<double> elapsed = end - start;
        std::this_thread::sleep_for(std::chrono::duration<double>(std::max(0.0, FRAME_INTERVAL_SEC - elapsed.count())));
    }

    close(sock);
}

int main(int argc, char *argv[]) {
    if (argc < 2 || argc > 3) {
        std::cerr << "Usage: ./metadata_sender <port> [--pad]\n";
        return 1;
    }

    int port = std::stoi(argv[1]);
    bool pad_mode = (argc == 3 && std::string(argv[2]) == "--pad");

    std::cout << "🚀 Sending object-detection metadata to 127.0.0.1:" << port
              << " at 30 FPS " << (pad_mode ? "(32KB padded)" : "(raw)") << std::endl;

    send_metadata(port, pad_mode);
    return 0;
}
