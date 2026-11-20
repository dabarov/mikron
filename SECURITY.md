# Security policy

## Supported versions

Only the latest release of Mikron receives security fixes. Please check that the problem exists in the latest version before reporting it.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue.

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/dabarov/mikron/security/advisories/new) of the repository and choose **Report a vulnerability**. Include what you found, how to reproduce it (a minimal page helps), the Chrome version and operating system, and what an attacker could do with it.

Mikron is maintained by volunteers. We will do our best to acknowledge a report within a week and to keep you informed while we work on a fix. When a fix is released we will publish an advisory and credit you, if you want to be credited.

## What counts

Examples of things we want to hear about: a web page being able to read data from Mikron's overlay or from the clipboard through Mikron, a page being able to trigger a clipboard write, code from a page running with the extension's privileges, or any network request made by the extension.

Mikron makes no network requests and collects no data. If you see otherwise, that is a bug we treat as a vulnerability.
