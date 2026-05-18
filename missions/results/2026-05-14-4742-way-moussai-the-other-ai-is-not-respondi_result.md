**Mouss-ai is back online.** Here's what happened:

- The server had received a `SIGTERM` at `11:51 UTC` today and never restarted — it has **no auto-restart mechanism** (no systemd service, no supervisor). Once it dies, it stays dead.
- The errors from `15:58 UTC` were repeated crash-restart attempts during the same outage period.
- I've restarted it and it's now connected as `@MoussAIBot` (PID 46731), running steadily.

The root problem is that neither Mouss-ai nor any of the generated agents have a process supervisor to keep them alive after crashes or reboots. You might want me to set up a systemd service or at minimum a cron-based health check that auto-restarts dead agents.