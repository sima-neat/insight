import argparse
import json
import random
import socket
import threading
import time

_last_shape_update = 0.0
_cached_segments = []

DEFAULT_FPS = 30.0
FRAME_WIDTH = 1280
FRAME_HEIGHT = 720


def generate_object_detection():
    locations = [
        [100, 100, 100, 80],
        [1080, 100, 100, 80],
        [100, 540, 100, 80],
        [1080, 540, 100, 80],
    ]
    person_boxes = [
        [200, 100, 60, 120],
        [1020, 100, 60, 120],
        [200, 500, 60, 120],
        [1020, 500, 60, 120],
    ]
    return {
        "type": "object-detection",
        "timestamp": time.time(),
        "data": {
            "objects": [
                {
                    "id": "obj_1",
                    "label": "car",
                    "confidence": round(random.uniform(0.7, 0.99), 2),
                    "bbox": random.choice(locations),
                },
                {
                    "id": "obj_2",
                    "label": "person",
                    "confidence": round(random.uniform(0.85, 0.99), 2),
                    "bbox": random.choice(person_boxes),
                },
            ]
        },
    }


def generate_classification():
    classes = ["urban", "nature", "indoor", "beach", "mountain"]
    return {
        "type": "classification",
        "timestamp": time.time(),
        "data": {
            "top_classes": [
                {"label": label, "confidence": round(random.uniform(0.3, 1.0), 2)}
                for label in random.sample(classes, 3)
            ]
        },
    }


def generate_pose_estimation():
    pose_templates = [
        {
            "nose": (200, 150),
            "left_eye": (190, 140),
            "right_eye": (210, 140),
            "left_shoulder": (180, 200),
            "right_shoulder": (220, 200),
        },
        {
            "nose": (1080, 570),
            "left_eye": (1070, 560),
            "right_eye": (1090, 560),
            "left_shoulder": (1060, 620),
            "right_shoulder": (1100, 620),
        },
    ]
    selected_pose = random.choice(pose_templates)
    return {
        "type": "pose-estimation",
        "timestamp": time.time(),
        "data": {
            "poses": [
                {
                    "id": "pose_1",
                    "label": "person",
                    "keypoints": [
                        {
                            "name": name,
                            "x": x,
                            "y": y,
                            "confidence": round(random.uniform(0.85, 1.0), 2),
                        }
                        for name, (x, y) in selected_pose.items()
                    ],
                }
            ]
        },
    }


def _random_polygon(num_points=4, width=FRAME_WIDTH, height=FRAME_HEIGHT):
    return [[random.randint(0, width), random.randint(0, height)] for _ in range(num_points)]


def _generate_segments():
    segments = []
    for index in range(random.randint(1, 3)):
        segments.append(
            {
                "id": f"seg_{index + 1}",
                "label": random.choice(["road", "grass", "car", "building"]),
                "mask_format": "polygon",
                "mask": _random_polygon(),
            }
        )
    if random.random() < 0.5:
        segments.append(
            {
                "id": "seg_rle",
                "label": "car",
                "confidence": round(random.uniform(0.8, 1.0), 2),
                "mask_format": "rle",
                "mask": "eJztwTEBAAAAwqD1T20ND6AAAA...",
            }
        )
    return segments


def generate_segmentation():
    global _last_shape_update, _cached_segments
    now = time.time()
    if now - _last_shape_update > 2.0:
        _cached_segments = _generate_segments()
        _last_shape_update = now
    return {"type": "segmentation", "timestamp": now, "data": {"segments": _cached_segments}}


GENERATOR_MAP = {
    "object-detection": generate_object_detection,
    "classification": generate_classification,
    "pose-estimation": generate_pose_estimation,
    "segmentation": generate_segmentation,
}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Send random simulated metadata to vf metadata UDP ports.")
    parser.add_argument("--host", default="127.0.0.1", help="Destination host (default: 127.0.0.1)")
    parser.add_argument("--start-port", type=int, default=9100, help="Starting UDP port (default: 9100)")
    parser.add_argument("--count", type=int, default=1, help="Number of parallel channels (default: 1)")
    parser.add_argument(
        "--types",
        default="object-detection",
        help="Comma-separated metadata types: object-detection, classification, pose-estimation, segmentation",
    )
    parser.add_argument("--fps", type=float, default=DEFAULT_FPS, help="Messages per second per channel (default: 30)")
    parser.add_argument("--seed", type=int, default=None, help="Optional RNG seed for repeatable output")
    parser.add_argument("--verbose", action="store_true", help="Print each emitted payload")
    return parser.parse_args(argv)


def resolve_enabled_types(types_value):
    return [name.strip() for name in types_value.split(",") if name.strip() in GENERATOR_MAP]


def metadata_sender(host, port, channel_id, enabled_types, frame_interval_sec, verbose):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        while True:
            start_time = time.perf_counter()
            type_choice = random.choice(enabled_types)
            payload = GENERATOR_MAP[type_choice]()
            message = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            sock.sendto(message, (host, port))
            if verbose:
                print(f"channel={channel_id} type={type_choice} dst={host}:{port} payload={message.decode('utf-8')}")
            elapsed = time.perf_counter() - start_time
            time.sleep(max(0.0, frame_interval_sec - elapsed))
    finally:
        sock.close()


def main(argv=None):
    args = parse_args(argv)
    if args.count < 1:
        raise SystemExit("--count must be >= 1")
    if args.fps <= 0:
        raise SystemExit("--fps must be > 0")

    if args.seed is not None:
        random.seed(args.seed)

    enabled_types = resolve_enabled_types(args.types)
    if not enabled_types:
        raise SystemExit("No valid metadata types specified")

    end_port = args.start_port + args.count - 1
    print(f"Starting {args.count} metadata sender threads to {args.host}:{args.start_port}-{end_port} at {args.fps:g} FPS")
    print(f"Enabled metadata types: {', '.join(enabled_types)}")

    frame_interval_sec = 1.0 / args.fps
    threads = []
    try:
        for channel_id in range(args.count):
            port = args.start_port + channel_id
            thread = threading.Thread(
                target=metadata_sender,
                args=(args.host, port, channel_id, enabled_types, frame_interval_sec, args.verbose),
                daemon=True,
            )
            thread.start()
            threads.append(thread)

        while True:
            time.sleep(10)
    except KeyboardInterrupt:
        print("Stopped metadata sender.")


if __name__ == "__main__":
    main()
