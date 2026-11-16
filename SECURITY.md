# Security

HQ is a remote control for AI agents that can run commands on your machines. Treat access to HQ like SSH access.

## How HQ protects you
- **Login.** A sign-in page with a signed session cookie (HttpOnly, SameSite=Lax, Secure over HTTPS). After 10 wrong
  passwords in 10 minutes, sign-in pauses for everyone (signed-in devices keep working). HQ refuses to start without a
  login on anything but `127.0.0.1`, and needs a password of at least 8 characters.
- **Cross-site requests are refused.** Another website can't make your signed-in browser send messages or change
  anything (checked with `Sec-Fetch-Site`, falling back to `Origin`). HQ can't be framed by other sites.
- **Model output can't run code in your browser.** Replies are rendered as Markdown and sanitised, and a
  Content-Security-Policy allows only HQ's own scripts, so even a reply that slipped past the sanitiser couldn't run one.
- **Your OpenCode passwords stay on the server.** The browser only knows HQ's login; HQ adds each OpenCode server's
  password when it relays a request, and only ever to that server's own address.
- **Secrets live outside the repo.** `~/.config/hq-app/config.json` (mode 600) holds HQ's login and your servers'
  passwords. HQ warns at startup if other users can read it. Model API keys are kept by OpenCode on each server
  (keys for servers added in Settings › Models are in that server's `opencode.json`).
- **Models make mistakes, so changes go through a copy.** Project chats work in a git worktree with a copy guard; you
  test, review and apply them yourself. Auto's reviewer is read-only.

## What you should do
- Keep HQ and your OpenCode servers on a private network (e.g. Tailscale). **Never expose an OpenCode server to the
  internet**, and put HTTPS in front of HQ (`tailscale serve`, Caddy, nginx) before using it from other devices.
- Give every OpenCode server a password (`OPENCODE_SERVER_PASSWORD`).
- Use a strong HQ password; changing it signs every device out. Deleting `secret` next to the config does the same.
- Review OpenCode's permission rules on each server: they decide what an agent may do without asking.
- The shared browser's control port listens on 127.0.0.1 without a password, so any program on HQ's computer could
  drive it. Don't sign in to accounts there that you wouldn't hand to an agent, or set `"browser": false`.

## Reporting a problem
Please report security issues privately through GitHub's **Report a vulnerability** button on this repository
(Security tab), not in a public issue. Include what you did, what happened, and the HQ and OpenCode versions.
