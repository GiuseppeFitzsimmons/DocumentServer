const argon2 = require('argon2');
argon2.hash(
    'LoadTest2026!',
    { type: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 }
).then(h => console.log(h))