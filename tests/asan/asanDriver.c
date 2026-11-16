/* The ASan harness's C side (tests/asan/asanBuild.mjs links it with the kernel under test; tests/asan/runAsan.mjs
   drives the module from Node). The arrays are malloc'd from JS through the module's exported malloc, so this file
   only sets ASan's options:
   - halt_on_error=0 (with -fsanitize-recover=address): a call reports every bad access, and the harness starts a fresh
     module after a call that wrote where it should not (a read changes nothing);
   - detect_leaks=0: the harness frees each case's arrays, and a leak report at exit is not what it looks for;
   - quarantine_size_mb=32: freed arrays stay poisoned for a while (a use after free), without growing the memory;
   - malloc_fill_byte / max_malloc_fill_size: a fresh array is 0xbe bytes throughout, not zeros a kernel could get away
     with reading (ASan does not see a read of memory nothing wrote; the harness fills each case's scratch with a
     different byte before each of its two runs, so such a read shows as two different outputs);
   - print_legend=0: the shadow bytes' legend is the same in every report. */
const char *__asan_default_options(void) {
  return "halt_on_error=0:detect_leaks=0:quarantine_size_mb=32:malloc_fill_byte=190:max_malloc_fill_size=268435456:"
         "print_legend=0";
}
