/* The ASan harness's self-check (tests/asan/kernels/canary.mjs): a loop that reads one element past its array, and one
   that writes one past it, as an off-by-one in a kernel would. runAsan.mjs runs it before the kernels; when ASan does
   not report both, at these lines, the harness could not see a kernel's overflow either, and the run fails. */
#include <stdint.h>

__attribute__((export_name("canary_read")))
uint32_t canary_read(const uint32_t *p, uint32_t n) {
  uint32_t s = 0;
  for (uint32_t i = 0; i <= n; i++) s += p[i]; /* CANARY_READ: i == n is past the array */
  return s;
}

__attribute__((export_name("canary_write")))
void canary_write(uint32_t *p, uint32_t n) {
  for (uint32_t i = 0; i <= n; i++) p[i] = i; /* CANARY_WRITE: i == n is past the array */
}

/* A wild pointer past the whole memory: ASan's shadow check of it traps (memory access out of bounds) before it can
   report, and the harness names the trap's line from the JavaScript stack. */
__attribute__((export_name("canary_wild")))
uint32_t canary_wild(const uint32_t *p) {
  return p[3]; /* CANARY_WILD */
}
