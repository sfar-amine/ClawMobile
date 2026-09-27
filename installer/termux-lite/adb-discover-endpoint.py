#!/data/data/com.termux/files/usr/bin/python3
import argparse, socket, struct, time

SERVICE = "_adb-tls-connect._tcp.local"

def enc(name):
    return b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\0"

def dec(buf, off, seen=None):
    seen = seen or set()
    parts = []
    while True:
        if off >= len(buf):
            return ".".join(parts), off
        n = buf[off]
        if n == 0:
            return ".".join(parts), off + 1
        if n & 0xC0 == 0xC0:
            ptr = ((n & 0x3F) << 8) | buf[off + 1]
            if ptr in seen:
                return ".".join(parts), off + 2
            seen.add(ptr)
            suffix, _ = dec(buf, ptr, seen)
            parts.append(suffix)
            return ".".join(parts), off + 2
        off += 1
        parts.append(buf[off:off+n].decode(errors="replace"))
        off += n

def discover(timeout_s=4.0):
    msg = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0) + enc(SERVICE) + struct.pack("!HH", 12, 0x8001)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(0.4)
    sock.bind(("0.0.0.0", 0))
    sock.sendto(msg, ("224.0.0.251", 5353))
    srvs, addrs = {}, {}
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            buf, _ = sock.recvfrom(9000)
        except socket.timeout:
            continue
        try:
            _, _, qd, an, ns, ar = struct.unpack("!HHHHHH", buf[:12])
            off = 12
            for _ in range(qd):
                _, off = dec(buf, off); off += 4
            for count in (an, ns, ar):
                for _ in range(count):
                    name, off = dec(buf, off)
                    typ, _, _, ln = struct.unpack("!HHIH", buf[off:off+10]); off += 10
                    ro = off; off += ln
                    if typ == 33 and ln >= 6:
                        _, _, port = struct.unpack("!HHH", buf[ro:ro+6])
                        target, _ = dec(buf, ro+6)
                        srvs[name] = (target.rstrip("."), port)
                    elif typ == 1 and ln == 4:
                        addrs[name.rstrip(".")] = socket.inet_ntoa(buf[ro:ro+4])
        except Exception:
            continue
    out = []
    for instance, (target, port) in srvs.items():
        ip = addrs.get(target)
        if ip and port:
            out.append((instance, ip, port))
    return sorted(set(out))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=4.0)
    ap.add_argument("--serial")
    args = ap.parse_args()
    for instance, ip, port in discover(args.timeout):
        if args.serial and args.serial not in instance:
            continue
        print(f"{ip}:{port}")

if __name__ == "__main__":
    main()
