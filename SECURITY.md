# Security policy

omp-lens runs git in whatever repository omp is opened in and draws file contents in your terminal, so it treats
repositories and files as untrusted. The README's [Security](README.md#security) section lists what it guards
against.

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub:
[Report a vulnerability](https://github.com/mindsers/omp-lens/security/advisories/new). Do not open a public
issue.

Useful to include: the omp-lens and omp versions, your OS, and a minimal repository or file that reproduces it.
You should get a first answer within a week. Fixes are released as a new version and credited in the changelog
unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes.

## In scope

- A repository, file or file name that makes omp-lens run a program, write outside the snapshot objects it
  documents, or send escape sequences to the terminal.
- omp-lens sending content to the agent that the README says it does not.

Out of scope: what the agent itself does with its tools, and git or omp vulnerabilities that omp-lens does not
make worse.
