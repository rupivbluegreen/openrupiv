"""Fixture tool: allocates memory well beyond RLIMIT_AS (256 MiB) to prove
the memory limit is enforced. Not a production tool."""
if __name__ == "__main__":
    chunks = []
    total = 0
    step = 32 * 1024 * 1024  # 32 MiB
    while total < 1024 * 1024 * 1024:  # would reach 1 GiB if unbounded
        chunks.append(bytearray(step))
        total += step
    print('{"allocated_beyond_limit": true}')
