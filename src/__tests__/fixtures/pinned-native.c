#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>

/* Network-free native Codex protocol fixture. Never reads or writes real configuration. */
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("codex-cli 0.142.3");
        return 0;
    }
    if (argc < 2 || strcmp(argv[1], "exec") != 0) return 20;
    if (getenv("CODEX_CHANNEL_EXECUTION_DIR") || getenv("CODEX_CHANNEL_EXECUTION_TOKEN")) return 21;
    while (getchar() != EOF) { }
    const char *mode = getenv("PINNED_NATIVE_MODE");
    const char *report = getenv("PINNED_NATIVE_REPORT");
    pid_t descendant = 0;
    if (mode && strcmp(mode, "hang") == 0) {
        descendant = fork();
        if (descendant < 0) return 22;
        if (descendant == 0) {
            signal(SIGTERM, SIG_IGN);
            for (;;) pause();
        }
    }
    if (report) {
        FILE *out = fopen(report, "w");
        if (!out) return 23;
        fprintf(out, "%ld %ld\n", (long)getpid(), (long)descendant);
        fclose(out);
    }
    if (mode && strcmp(mode, "hang") == 0) {
        signal(SIGTERM, SIG_IGN);
        for (;;) pause();
    }
    puts("{\"type\":\"thread.started\",\"thread_id\":\"11111111-1111-4111-8111-111111111111\"}");
    if (mode && strcmp(mode, "fail") == 0) {
        puts("{\"type\":\"turn.failed\",\"error\":{\"message\":\"synthetic native failure\"}}");
        return 1;
    }
    puts("{\"type\":\"item.completed\",\"item\":{\"id\":\"native-answer\",\"type\":\"agent_message\",\"text\":\"native synthetic answer\"}}");
    puts("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}");
    return 0;
}
