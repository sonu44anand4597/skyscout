# SkyScout

The SkyScout flight search and fare monitoring application lives in [`SkyScout/`](SkyScout/).

- App setup and features: [SkyScout/README.md](SkyScout/README.md)
- Deployment requirements and runbook: [SkyScout/docs/deployment.md](SkyScout/docs/deployment.md)
- CI checks: [.github/workflows/ci.yml](.github/workflows/ci.yml)

The app uses React/Vite, Express, MongoDB Atlas and a separately supervised price-monitoring worker. Keep private provider and database credentials in backend runtime secrets; local `.env` files are excluded from this repository.
