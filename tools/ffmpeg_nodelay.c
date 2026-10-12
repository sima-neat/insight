/* LD_PRELOAD shim: set TCP_NODELAY on every socket before connect().
 *
 * ffmpeg's RTSP muxer opens its own TCP connection and never applies
 * -tcp_nodelay to it. Remove this once the base image ships an ffmpeg that
 * propagates the option (libavformat/rtsp.c, ff_rtsp_connect).
 *
 * Issues the syscall rather than calling dlsym(RTLD_NEXT, "connect"): dlsym is
 * GLIBC_2.34, and the wheels are tagged manylinux2014, which promises glibc
 * 2.17. The cost is that a connect() hook in another preloaded object is
 * bypassed rather than chained to.
 */
#define _GNU_SOURCE
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    return syscall(SYS_connect, fd, addr, len);
}
