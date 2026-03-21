import os
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

def generate_dot_from_pipeline(
    gst_string: str,
    output_path: str = "/tmp",
    output_name: str = "pipeline",
    env_vars: dict = None
) -> str:
    """
    Generates a GStreamer DOT graph file from a given pipeline string.

    This function parses and launches a GStreamer pipeline, transitions it to
    the PLAYING state to resolve dynamic pads, and writes a DOT file representing
    the pipeline structure. It supports custom plugin paths and environment settings
    via `env_vars`.

    Args:
        gst_string (str): The GStreamer pipeline description string.
        output_path (str): Directory to write the DOT file (default: "/tmp").
        output_name (str): Base name for the DOT file (without extension).
        env_vars (dict, optional): Dictionary of environment variables to set
                                   (e.g., GST_PLUGIN_PATH, LD_LIBRARY_PATH).

    Returns:
        str: Full path to the generated DOT file.

    Raises:
        RuntimeError: If pipeline parsing or state transition fails, or if
                      the DOT file is not created.
    """
    print('--'*100, env_vars)
    if not os.path.isdir(output_path):
        os.makedirs(output_path)

    if env_vars:
        for k, v in env_vars.items():
            os.environ[k] = v

    os.environ["GST_DEBUG_DUMP_DOT_DIR"] = output_path

    if not Gst.is_initialized():
        Gst.init([])

    try:
        pipeline = Gst.parse_launch(gst_string)
    except GLib.Error as e:
        raise RuntimeError(f"Error parsing pipeline: {e}")

    ret = pipeline.set_state(Gst.State.PLAYING)
    if ret == Gst.StateChangeReturn.FAILURE:
        raise RuntimeError("Failed to set pipeline to PAUSED")

    pipeline.get_state(Gst.CLOCK_TIME_NONE)

    Gst.debug_bin_to_dot_file(pipeline, Gst.DebugGraphDetails.ALL, output_name)

    full_path = os.path.join(output_path, f"{output_name}.dot")
    if not os.path.isfile(full_path):
        raise RuntimeError(f"DOT file {full_path} was not created")

    pipeline.set_state(Gst.State.NULL)
    return full_path
