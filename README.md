# BMAP API

A high-performance Bitcoin transaction processing and serving API built with Bun and Elysia.js. This service processes Bitcoin SV transactions, providing social features, caching, and real-time updates.

## Features

- **Transaction Processing**: Ingest and store Bitcoin transactions with MongoDB and Redis caching
- **Social Features**: Friends, identities, and likes system
- **Real-time Updates**: Stream Bitcoin transactions via JungleBus
- **Dynamic Charts**: Generate transaction visualizations using Chart.js
- **BAP Integration**: Bitcoin Attestation Protocol identity management
- **High Performance**: Built with Bun runtime and Elysia.js framework
- **API Documentation**: Interactive Swagger/OpenAPI documentation
- **Native TypeScript**: Direct TypeScript execution with Bun

## Prerequisites

- [Bun](https://bun.sh) runtime
- MongoDB instance
- Redis instance

## Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd bmap-api
```

2. Install dependencies:
```bash
bun install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

Required environment variables:
- `REDIS_PRIVATE_URL`: Redis connection string
- `BMAP_MONGO_URL`: MongoDB connection URL

## Development

Start the development server with hot reload:
```bash
bun run dev
```

The server will start at `http://localhost:3000`. You can access:
- API at `http://localhost:3000/`
- Swagger documentation at `http://localhost:3000/swagger`

### Scripts

- `bun run dev`: Run development server with hot reload
- `bun run start`: Run production server
- `bun run typecheck`: Run TypeScript type checking
- `bun run lint`: Run Biome checks
- `bun run lint:fix`: Auto-fix Biome issues
- `bun run test-redis`: Test Redis connectivity
- `bun run prepare-hooks`: Set up Git hooks

### Code Quality

The project uses several tools to maintain code quality:

- **TypeScript**: Native support via Bun
- **Biome**: For linting and formatting
- **Git Hooks**: Pre-commit and pre-push checks
- **MongoDB Indexes**: For query optimization
- **Swagger/OpenAPI**: API documentation and testing

### Development Guidelines

1. **Code Style**
   - Follow Biome formatting rules
   - Use TypeScript types and interfaces
   - Document complex logic
   - Keep files focused and modular
   - Document API endpoints using Swagger decorators

2. **Error Handling**
   - Use typed error responses
   - Implement proper error boundaries
   - Log errors with context
   - Handle edge cases explicitly

3. **Performance**
   - Use Redis caching appropriately
   - Implement proper indexes
   - Consider batch processing
   - Monitor memory usage

4. **Security**
   - Validate input data
   - Sanitize database queries
   - Use proper error messages
   - Consider rate limiting

## API Documentation

The API is documented using Swagger/OpenAPI specification. You can access the interactive documentation at `/swagger` when the server is running.

### Available Documentation

- **Interactive UI**: Available at `/swagger`
- **OpenAPI Spec**: Available at `/swagger/json`
- **API Explorer**: Test endpoints directly from the browser

### API Categories

#### Transactions
- Query and retrieve transaction data
- Real-time transaction updates
- Transaction processing status

#### Social Features
- Friends management
- Identity lookup
- Like system
- Message interactions

#### Charts
- Dynamic chart generation
- Time series visualizations
- Custom chart parameters

## Architecture

### Data Storage

**MongoDB Collections**:
- `c`: Confirmed transactions
- `u`: Unconfirmed transactions

**Redis Caching**:
- Transaction data
- BAP identities
- Social graph information

### Core Components

- **Transaction Processing**: Handles ingestion and normalization
- **Caching Layer**: Manages Redis caching and invalidation
- **Social Features**: Handles friend relationships and likes
- **Chart Generation**: Creates dynamic visualizations
- **BAP Integration**: Manages Bitcoin identities
- **API Documentation**: Swagger/OpenAPI integration

## Contributing

1. Fork the repository
2. Create your feature branch
3. Run tests and ensure code quality:
   ```bash
   bun run lint
   bun run build
   ```
4. Submit a pull request

## License

[Add License Information]

## Support

[Add Support Information] 