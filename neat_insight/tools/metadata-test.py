import socket
import json
import time
import random
import threading
import argparse

_last_shape_update = 0
_cached_segments = []

FRAME_INTERVAL_SEC = 1.0 / 30.0  # ~33.333ms
FRAME_WIDTH = 1280
FRAME_HEIGHT = 720

def generate_object_detection():
    locations = [
        [100, 100, 100, 80],    # top-left
        [1080, 100, 100, 80],   # top-right
        [100, 540, 100, 80],    # bottom-left
        [1080, 540, 100, 80]    # bottom-right
    ]
    person_boxes = [
        [200, 100, 60, 120],
        [1020, 100, 60, 120],
        [200, 500, 60, 120],
        [1020, 500, 60, 120]
    ]
    car_box = random.choice(locations)
    person_box = random.choice(person_boxes)
    return {
        "type": "object-detection",
        "timestamp": time.time(),
        "data": {
            "objects": [
                {
                    "id": "obj_1",
                    "label": "car",
                    "confidence": round(random.uniform(0.7, 0.99), 2),
                    "bbox": car_box
                },
                {
                    "id": "obj_2",
                    "label": "person",
                    "confidence": round(random.uniform(0.85, 0.99), 2),
                    "bbox": person_box
                }
            ]
        }
    }


def generate_classification():
    classes = ["urban", "nature", "indoor", "beach", "mountain"]
    top = random.sample(classes, 3)
    return {
        "type": "classification",
        "timestamp": time.time(),
        "data": {
            "top_classes": [
                {"label": cls, "confidence": round(random.uniform(0.3, 1.0), 2)}
                for cls in top
            ]
        }
    }

def generate_pose_estimation():
    pose_templates = [
        {  # Top-left pose
            "nose": (200, 150),
            "left_eye": (190, 140),
            "right_eye": (210, 140),
            "left_shoulder": (180, 200),
            "right_shoulder": (220, 200),
        },
        {  # Bottom-right pose
            "nose": (1080, 570),
            "left_eye": (1070, 560),
            "right_eye": (1090, 560),
            "left_shoulder": (1060, 620),
            "right_shoulder": (1100, 620),
        }
    ]

    selected_pose = random.choice(pose_templates)
    keypoints = [
        {
            "name": name,
            "x": x,
            "y": y,
            "confidence": round(random.uniform(0.85, 1.0), 2)
        }
        for name, (x, y) in selected_pose.items()
    ]

    return {
        "type": "pose-estimation",
        "timestamp": time.time(),
        "data": {
            "poses": [
                {
                    "id": "pose_1",
                    "label": "person",
                    "keypoints": keypoints
                }
            ]
        }
    }


def _random_polygon(num_points=4, width=FRAME_WIDTH, height=FRAME_HEIGHT):
    return [[random.randint(0, width), random.randint(0, height)] for _ in range(num_points)]

def _generate_segments():
    segments = []
    num_segments = random.randint(1, 3)
    for i in range(num_segments):
        segments.append({
            "id": f"seg_{i+1}",
            "label": random.choice(["road", "grass", "car", "building"]),
            "mask_format": "polygon",
            "mask": _random_polygon()
        })
    if random.random() < 0.5:
        segments.append({
            "id": "seg_rle",
            "label": "car",
            "confidence": round(random.uniform(0.8, 1.0), 2),
            "mask_format": "rle",
            "mask": "eJztwTEBAAAAwqD1T20ND6AAAA..."  # Placeholder RLE
        })
    return segments

def generate_segmentation():
    global _last_shape_update, _cached_segments
    now = time.time()
    if now - _last_shape_update > 2.0:
        _cached_segments = _generate_segments()
        _last_shape_update = now
    return {
        "type": "segmentation",
        "timestamp": now,
        "data": {
            "segments": _cached_segments
        }
    }

GENERATOR_MAP = {
    "object-detection": generate_object_detection,
    "classification": generate_classification,
    "pose-estimation": generate_pose_estimation,
    "segmentation": generate_segmentation,
}

def metadata_sender(port, channel_id, enabled_types):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    while True:
        start_time = time.perf_counter()
        type_choice = random.choice(enabled_types)
        metadata = GENERATOR_MAP[type_choice]()
        message = json.dumps(metadata).encode('utf-8')
        sock.sendto(message, ('127.0.0.1', port))
        print(f"📤 Channel {channel_id}: Sent {type_choice} to 127.0.0.1:{port} → {message.decode('utf-8')}")
        elapsed = time.perf_counter() - start_time
        time.sleep(max(0, FRAME_INTERVAL_SEC - elapsed))

def main():
    parser = argparse.ArgumentParser(description="Send random simulated metadata to UDP at 30 FPS.")
    parser.add_argument("--start-port", type=int, default=9100, help="Starting UDP port")
    parser.add_argument("--count", type=int, default=1, help="Number of parallel ports/channels")
    parser.add_argument("--types", type=str, default="object-detection",
                        help="Comma-separated metadata types (e.g., object-detection,classification)")

    args = parser.parse_args()
    enabled_types = [t.strip() for t in args.types.split(",") if t.strip() in GENERATOR_MAP]

    if not enabled_types:
        print("❌ No valid metadata types specified. Exiting.")
        return

    print(f"🌐 Starting {args.count} metadata threads to 127.0.0.1:{args.start_port}–{args.start_port + args.count - 1} @ 30 FPS")
    print(f"🎲 Enabled metadata types: {enabled_types}")

    threads = []
    try:
        for i in range(args.count):
            port = args.start_port + i
            t = threading.Thread(target=metadata_sender, args=(port, i, enabled_types), daemon=True)
            t.start()
            threads.append(t)

        while True:
            time.sleep(10)
    except KeyboardInterrupt:
        print("🛑 Stopped.")

if __name__ == "__main__":
    main()
