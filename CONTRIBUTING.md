# Contributing to AgentMe

Thank you for your interest in contributing to AgentMe!

## How to Contribute

### Reporting Issues

- Search existing issues before creating a new one
- Use issue templates when available
- Include reproduction steps for bugs
- For security vulnerabilities, email vladimir.beran@etnetera.cz

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `make test`
5. Run linter: `make lint`
6. Commit with conventional commits: `git commit -m "feat: add new feature"`
7. Push and create a PR

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `test:` Test additions or fixes
- `refactor:` Code refactoring
- `chore:` Maintenance tasks

### Code Style

- **Rust**: Follow [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) and run `cargo fmt`
- **Solidity**: Follow [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html)
- **TypeScript**: ESLint + Prettier configuration in repo

### Testing

- Write tests for new features
- Maintain >80% code coverage
- Run full test suite before submitting PR

## Development Setup

```bash
# Clone repository
git clone https://github.com/agentmecz/agentme.git
cd agentme

# Install dependencies
make install-deps

# Run tests
make test

# Build
make build
```

## Areas for Contribution

- **Protocol specs**: Help refine specifications in `docs/specs/`
- **Node implementation**: Rust code in `node/`
- **Smart contracts**: Solidity contracts in `contracts/`
- **SDK development**: TypeScript SDK in `sdk/`
- **Documentation**: Improve docs and tutorials
- **Testing**: Add test coverage

## Code of Conduct

Be respectful and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Questions?

- [GitHub Issues](https://github.com/agentmecz/agentme/issues)
