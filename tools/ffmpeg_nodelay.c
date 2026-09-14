/* LD_PRELOAD shim: set TCP_NODELAY on every socket before connect().
 *
 * ffmpeg's RTSP muxer opens its own TCP connection and never applies
 * -tcp_nodelay to it. Remove this once the base image ships an ffmpeg that
 * propagates the option (libavformat/rtsp.c, ff_rtsp_connect).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    static int (*real_connect)(int, const struct sockaddr *, socklen_t);
    if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    return real_connect(fd, addr, len);
}
