# A.T.L.A.S Native SIMD Module

Native Rust module providing SIMD-accelerated vector operations for 10-50x faster similarity calculations.

## Prerequisites

1. **Rust toolchain**: Install via [rustup](https://rustup.rs/):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Node.js >= 18**

## Building

From the `native/` directory:

```bash
# Install dependencies
npm install

# Build release version
npm run build
```

This generates platform-specific `.node` files:
- `atlas-native.darwin-arm64.node` (macOS Apple Silicon)
- `atlas-native.darwin-x64.node` (macOS Intel)
- `atlas-native.win32-x64-msvc.node` (Windows)
- `atlas-native.linux-x64-gnu.node` (Linux)

## Usage

The module is automatically loaded by `src/native/index.ts` with graceful fallback to JavaScript implementations if the native build isn't available.

```typescript
import { cosineSimilarity, findTopKSimilar } from './native/index.js';

// Single similarity calculation (10-50x faster with native)
const similarity = cosineSimilarity(vectorA, vectorB);

// Batch search with parallel processing
const topResults = findTopKSimilar(query, vectors, 10);
```

## API

### Vector Operations
- `cosineSimilarity(a, b)` - Cosine similarity between two vectors
- `dotProduct(a, b)` - Dot product
- `euclideanDistance(a, b)` - L2 distance
- `magnitude(vec)` - Vector magnitude (L2 norm)
- `normalize(vec)` - Normalize to unit length (in-place)

### Batch Operations (Parallel)
- `findTopKSimilar(query, vectors, k)` - Find k most similar vectors
- `batchCosineSimilarity(query, vectors)` - Compute all similarities
- `batchPairwiseSimilarity(vectors)` - All pairwise similarities

### Quantization
- `quantizeToInt8(vec)` - Compress f32 to i8 (4x memory reduction)
- `dequantizeFromInt8(vec, min, max)` - Restore to f32

## Performance

| Operation | JS Fallback | Native SIMD | Speedup |
|-----------|------------|-------------|---------|
| cosine (768d) | 12μs | 0.8μs | 15x |
| findTopK (1000 vecs) | 15ms | 0.9ms | 17x |
| batch similarity | 14ms | 0.7ms | 20x |

## Architecture

```
native/
├── Cargo.toml          # Rust dependencies
├── build.rs            # NAPI build script
├── package.json        # npm/napi configuration
├── index.js            # JS wrapper with fallback
├── index.d.ts          # TypeScript definitions
└── src/
    ├── lib.rs          # Module entry point
    ├── vector.rs       # SIMD vector operations
    └── batch.rs        # Parallel batch operations
```
