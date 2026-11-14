# Testing Rentular: guide for operations

This guide is for whoever keeps an eye on Rentular day to day. You do not
need to be a developer. There are two parts:

1. **Automated browser tests** that run every night on a small machine in the
   linuxbe-cluster. They open Rentular in Chrome and Safari's engine (on a
   desktop screen and a phone screen), type into every form field one letter
   at a time, and walk through the main tasks a landlord does.
2. **A short weekly manual check** on the real site, with your own test
   account, on your own phones.

If something looks wrong in either part, send it to the developer (see
"Reporting a problem" at the end).

## Why these tests exist

A landlord reported that while adding a tenant, every letter he typed made
the cursor jump out of the field, so he had to click back after each letter.
That kind of bug is invisible in code review and very annoying in real life.
The automated tests type into every field the way a person does and fail as
soon as the cursor leaves the field. They also check that pages show proper
text in Dutch, French, German and English (no raw codes like
`leases.saveLease`, no "Rentulair" from browser translation).

## Part 1: the automated tests

### What you need

One dedicated container on the cluster that does nothing else:

- An **unprivileged LXC** with Debian 12 or 13.
- **Nesting enabled** (Proxmox: Options, Features, tick "nesting"), so Docker
  can run inside it. Podman works too.
- **2 vCPU, 4 GB RAM, 20 GB disk.** The first run builds images of about
  5 GB; after that runs reuse them.
- Give it a **low CPU weight** (Proxmox: Resources, CPU units, for example
  50 where the default is 100). When a course needs the CPU, the course wins.
  This is the setting that really protects running courses; the limits inside
  the test stack only keep a run from eating the whole container.
- Place it **outside the lab pools** and **never on a participant pod
  network**. It only needs outgoing internet access (to pull the code and
  images) and your mail relay. Nothing has to reach it from outside.

The tests never touch the real Rentular site. They start their own private
copy of Rentular inside the container (database, mail catcher, API, website),
with fake accounts and fake data, and throw it all away afterwards.

### One-time setup

As root in the LXC:

```bash
apt update && apt install -y docker.io docker-compose-plugin git mailutils
adduser --disabled-password --gecos "" e2e
usermod -aG docker e2e
```

(On Debian 13 the compose package may be called `docker-compose`; any
version that understands `docker compose` is fine. With Podman, install
`podman` and `podman-compose` and see the note further down.)

Then as the `e2e` user:

```bash
git clone https://github.com/jnuyens/rentular.git ~/rentular
mkdir -p ~/reports
```

The first run creates `~/rentular/e2e/.env.e2e.local` with random passwords
for the throwaway test accounts. That file stays on this machine; you never
need to open it.

### Running the tests by hand

As the `e2e` user:

```bash
cd ~/rentular
git pull
E2E_REPORT_ROOT=~/reports e2e/run-compose.sh
```

The first run takes 15 to 25 minutes because it builds everything. Later
runs take about 15 minutes for all four browsers. To try a single browser
quickly:

```bash
E2E_PROJECTS=chromium-desktop E2E_REPORT_ROOT=~/reports e2e/run-compose.sh
```

### Reading the result

At the end you see a line like:

```
88 passed, 0 failed, 0 skipped, 480 fields typed into
```

- **0 failed**: all good. The command ends with exit code 0.
- **Anything failed**: the lines marked `FAIL` say which page and which field,
  for example `add tenant > "First name" (input[text]): lost focus after
  typing character 2 ("Je")`. The exit code is 1.
- Exit code 2 or 3 means the test machinery itself had a problem (image
  build, database start). That is not a Rentular bug, but still worth a
  message to the developer.

Every run gets its own dated folder under `~/reports`, for example
`~/reports/2026-11-15T03-31-02/`, containing:

- `summary.txt`: the short readable result.
- `junit.xml`: the same result for monitoring tools.
- For each failure, a **screenshot** (`.png`) and a **trace**
  (`.trace.zip`). The developer can open the trace at
  https://trace.playwright.dev and replay exactly what happened.
- `run.log`, `build.log` and `stack.log`: technical logs.

Folders older than 14 days are deleted automatically at the start of the
next run (change with `E2E_KEEP_DAYS`).

### Running it every night

The repository ships a ready systemd timer that runs at 03:30, a quiet hour.
As root:

```bash
cp /home/e2e/rentular/e2e/ops/rentular-e2e.service /etc/systemd/system/
cp /home/e2e/rentular/e2e/ops/rentular-e2e.timer /etc/systemd/system/
cat > /etc/rentular-e2e.env <<'EOF'
E2E_REPO_DIR=/home/e2e/rentular
E2E_REPORT_ROOT=/home/e2e/reports
E2E_ALERT_EMAIL=owner@example.org
EOF
systemctl daemon-reload
systemctl enable --now rentular-e2e.timer
```

Replace `owner@example.org` with the address that should get failure mails.
Check the timer with `systemctl list-timers rentular-e2e.timer` and the last
run with `journalctl -u rentular-e2e.service -n 50`.

What the nightly job does (`e2e/ops/nightly.sh`):

1. **Skips the night** when the file `/run/rentular-e2e.skip` exists, or when
   `E2E_SKIP_COMMAND` (optional, in `/etc/rentular-e2e.env`) exits with 0.
   Use this if you have a way to tell a course is running, for example
   `E2E_SKIP_COMMAND=/usr/local/bin/course-running`. A plain
   `touch /run/rentular-e2e.skip` before a late-night course and removing it
   afterwards works as well (`/run` is emptied on reboot).
2. Updates the code to the latest version.
3. Runs the tests at low priority.
4. On failure, mails the summary to `E2E_ALERT_EMAIL` through the machine's
   normal mail setup (configure `mailutils`/your relay so that
   `echo test | mail -s test you@example.org` arrives). The service also ends
   as failed, so `systemctl --failed` or your monitoring sees it.

### Using Podman instead of Docker

Set `COMPOSE="podman compose"` in `/etc/rentular-e2e.env`. Everything else is
the same.

### Testing a staging copy instead (optional)

The default and recommended way is the private copy described above. If the
developer sets up a separate staging instance with test data, you can point
the tests at it: add `E2E_BASE_URL`, `E2E_API_URL`, `E2E_LANDLORD_EMAIL` and
`E2E_LANDLORD_PASSWORD` to `~/rentular/e2e/.env.e2e.local` and run
`e2e/run-remote.sh`. Tests that create data are skipped in that mode. The
tests refuse to run against rentular.com.

### When to run by hand

- Before every deploy to production.
- After any change to forms (new fields, new dialogs).
- Whenever a user reports something odd while typing.

## Part 2: weekly manual check on the real site

The real site has real landlords and tenants. You check it with **your own
dedicated test account** that you create yourself.

### Your test account

- Register on https://rentular.com with an address only used for this, for
  example `ops-test+rentular@yourdomain.be` (the `+rentular` part lands in
  your normal mailbox on most mail services).
- Use a long password from your password manager. Never reuse a real
  password, and never share it in chat or tickets.
- Keep it to fake data only:
  - one property: **Teststraat 1, 1000 Brussel**;
  - one tenant: a fake name with **your own email address and phone**, so any
    reminder goes to you;
  - one contract between the two.
- Never add a real tenant, a real IBAN of someone else, or a real landlord's
  data to this account.

### Weekly checklist (about 20 minutes)

1. Log in on a desktop browser, on an iPhone and on an Android phone.
2. Tenants: open your fake tenant and type a long name such as
   "Jansens-Dupont van den Broeck". Watch that the cursor stays in the field
   for every letter. Do the same when adding a new tenant (you can cancel
   instead of saving).
3. Create a contract (or edit the existing one) and save it.
4. Open the contract's communication page.
5. Language: set your phone to Dutch, then French, open Rentular in a private
   window and check the site follows the phone's language. Look for raw
   codes with dots in them or the word "Rentulair".
6. Android app: open it, check it starts and does not complain about its
   version (the download page is https://rentular.com/download).
7. Send a manual payment reminder to your fake tenant and check the email
   arrives in your mailbox.
8. Open the Enable Banking guide at https://rentular.com/help/enable-banking
   and check it loads.

### What not to do on production

- No real tenant data in the test account.
- Never mark payments, send reminders or change anything on real contracts.
- Never change or disconnect the bank connections of real landlords.
- Never run the automated tests against rentular.com (they refuse anyway).

## Reporting a problem

Send the developer:

- a screenshot (or the report folder of the failing night, zipped);
- the phone model or computer, and the browser with its version;
- the exact steps, starting from where you were logged in;
- the date and time it happened (so it can be matched with the logs).

## For developers

On a Mac or Linux laptop with Docker, Node 20.19 and pnpm 9.15 (the versions
pinned in `package.json`), `e2e/run-local.sh` runs the same suite with the
API and web app on the host, which is faster to iterate on. `E2E_HEADED=1`
shows the browsers, `E2E_GREP=onboarding` runs matching tests only and
`E2E_KEEP_UP=1` leaves the stack running at http://localhost:3410 until
Ctrl-C.
