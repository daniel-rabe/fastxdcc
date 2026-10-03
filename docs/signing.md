# Code signing

The Windows builds are currently **unsigned**. Windows SmartScreen shows a
"Windows protected your PC" warning the first time someone runs the installer,
which they have to click through via *More info → Run anyway*.

This document covers what signing would take, and how the repository is already
set up for it.

> Prices and the exact shape of third-party tooling move. Check each provider's
> current documentation before committing to one.

## Why there is no cheap certificate any more

Since June 2023 the CA/Browser Forum baseline requirements have mandated that
code-signing private keys live on FIPS 140-2 Level 2 (or equivalent) hardware.
That ended the era of a $70 downloadable `.pfx` file. Every option below is
either a hardware token, a cloud signing service, or a donated certificate.

| Option | Rough cost | Main constraint |
| --- | --- | --- |
| Microsoft Trusted Signing | ~$10/month | Eligibility has been limited by country and organisation age |
| SignPath Foundation | Free | Open source only, and they review for relevance |
| Certum Open Source | ~€30/yr + token | Issued to an individual; requires evidence of open-source work |
| Commercial OV | ~$200–400/yr | Needs a registered business and a hardware token |
| Commercial EV | ~$300–600/yr | The only option with immediate SmartScreen reputation |

Two things matter more than the price:

- **OV certificates do not clear the SmartScreen warning straight away.**
  Reputation accrues per certificate as downloads accumulate. Only EV is
  trusted from the first download. If removing the warning quickly is the goal,
  the cheap tiers will not do it.
- **Hardware tokens break unattended builds.** The USB token has to be
  physically present, so releases stop being automatable. Trusted Signing and
  SignPath both avoid this.

## SignPath Foundation

SignPath donates certificates and signing infrastructure to open-source
projects. It is free, and it is the best fit for a project like this one — but
it has a hard requirement that shapes the whole release process.

### Origin verification

SignPath will only sign artifacts that a **public CI service built from the
public repository**. A binary built on a developer's machine and uploaded
cannot be signed; that is the entire point of the scheme, since the donated
certificate has to vouch for something verifiable.

So once signing is in place, [`.github/workflows/release.yml`](../.github/workflows/release.yml)
is the release path, not `npm run dist` on a laptop. Local builds remain fine
for testing — they are simply never signed.

### Eligibility checklist

| Requirement | Status |
| --- | --- |
| OSI-approved licence | ✅ MIT, see [`LICENSE`](../LICENSE) |
| Public source repository | ⬜ not pushed anywhere yet |
| Build runs on a public CI | ✅ workflow is in place, needs a repo to run in |
| Reproducible dependency install | ✅ `npm ci` against the committed lock file |
| Not a commercial product | ✅ |
| Project relevance / user base | ⚠️ see below |

**The relevance criterion is the real obstacle.** SignPath reviews applications
by hand and looks for projects with genuine users. A repository with no release
history, no stars and no downloads is likely to be declined, and reapplying
later is better than being turned down now. The honest sequence is: publish,
tag some releases, let people actually use it, then apply.

If signing is wanted before that, Microsoft Trusted Signing has no open-source
or notability requirement.

## Application draft

Submit at <https://signpath.org/apply>. Replace anything in angle brackets, and
check the form's current fields — this is a draft of the substance, not a
field-by-field transcript.

> **Project name:** fastxdcc
>
> **Repository:** `<https://github.com/><your-account>/fastxdcc`
>
> **Licence:** MIT
>
> **What it does:** fastxdcc is a desktop IRC client specialised for XDCC file
> transfers. It connects to IRC networks, joins channels, requests packs from
> XDCC bots, accepts the resulting DCC offers and writes the files to disk,
> with resume support for interrupted transfers. It ships as an Electron
> desktop application and as a terminal UI built on Ink, both driving the same
> headless core.
>
> **Why it needs signing:** It is distributed to end users as a Windows
> installer and a portable executable. Unsigned, every user meets a SmartScreen
> warning on first run and has to deliberately override it — which is exactly
> the habit that makes users vulnerable to genuinely malicious downloads.
>
> **How it is built:** GitHub Actions on `windows-latest`, from the public
> repository, on a version tag. Dependencies are installed with `npm ci`
> against a committed lock file. The build runs a typecheck and the full test
> suite (280 tests) before packaging with electron-builder. No step takes input
> from outside the repository.
>
> **Artifacts to sign:** an NSIS installer (`fastxdcc Setup <version>.exe`) and
> a portable executable (`fastxdcc-<version>-portable.exe`). Both are Electron
> packages, so the binaries inside the installer need signing as well as the
> installer itself.
>
> **Maintainer:** `<your name>`, `<your email>`, `<your GitHub account>`

## Setting it up once accepted

SignPath creates an organisation and a project for you. Then:

1. In the repository, add a **secret** `SIGNPATH_API_TOKEN` and a **variable**
   `SIGNPATH_ORGANIZATION_ID`. The workflow checks for both and skips signing
   entirely when they are absent, so nothing breaks before this point.
2. Confirm the slugs in the workflow match what SignPath created for you:
   `project-slug`, `signing-policy-slug`, and `artifact-configuration-slug`.
   The artifact configuration must be one that signs the binaries *inside* the
   installer and repacks it — signing only the outer installer leaves the
   application executable unsigned.
3. Push a `v*` tag. The workflow builds, uploads the unsigned artifacts,
   submits them to SignPath, and attaches the signed results as a separate
   artifact.

### Verifying the result

Do not trust the build log alone — confirm the signature on the downloaded file:

```bash
powershell -Command "Get-AuthenticodeSignature '.\fastxdcc Setup 0.2.0.exe' | Format-List"
```

`Status` must be `Valid`. Check the inner executable too, by extracting the
installer or installing it and inspecting `fastxdcc.exe`.
