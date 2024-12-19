import type { BapIdentity } from '../bap.js';
import { client, saveToRedis } from '../cache.js';

async function testRedisConnection() {
  try {
    // Test Redis connection
    console.log('Testing Redis connection...');
    await client.connect();

    if (!client.isReady) {
      throw new Error('Redis client is not ready');
    }

    console.log('Redis connection successful!');

    // Clear existing test data
    const existingKeys = await client.keys('signer-test*');
    if (existingKeys.length > 0) {
      console.log('Clearing existing test data...');
      await Promise.all(existingKeys.map((key) => client.del(key)));
    }

    // Insert test data
    console.log('Inserting test data...');
    const testIdentities: BapIdentity[] = [
      {
        idKey: 'test1',
        rootAddress: '13ZNtS7f3Yb5QiYsJgNpXq7S994hcPLaKv',
        currentAddress: '1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
        addresses: [
          {
            address: '1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
            txId: 'f39575e7ac17f8590f42aa2d9f17b743d816985e85632303281fe7c84c3186b3',
            block: 697159,
          },
        ],
        // Test with a JSON string identity
        identity: JSON.stringify({
          '@type': 'Person',
          alternateName: 'TestUser1',
          description: 'Test user description',
          homeLocation: { name: 'Bitcoin' },
          image: '/test-image-hash-1',
          paymail: 'test1@handcash.io',
          url: 'https://1sat.market',
        }),
        identityTxId: 'test1identitytx',
        block: 697159,
        timestamp: Math.floor(Date.now() / 1000),
        valid: true,
      },
      {
        idKey: 'test2',
        rootAddress: '15ZNtS7f3Yb5QiYsJgNpXq7S994hcPLaKv',
        currentAddress: '2HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
        addresses: [
          {
            address: '2HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
            txId: 'g39575e7ac17f8590f42aa2d9f17b743d816985e85632303281fe7c84c3186b3',
            block: 697160,
          },
        ],
        // Test with a simple string identity
        identity: 'TestUser2',
        identityTxId: 'test2identitytx',
        block: 697160,
        timestamp: Math.floor(Date.now() / 1000),
        valid: true,
      },
      {
        idKey: 'test3',
        rootAddress: '16ZNtS7f3Yb5QiYsJgNpXq7S994hcPLaKv',
        currentAddress: '3HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
        addresses: [
          {
            address: '3HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY',
            txId: 'h39575e7ac17f8590f42aa2d9f17b743d816985e85632303281fe7c84c3186b3',
            block: 697161,
          },
        ],
        // Test with an object identity
        identity: {
          '@type': 'Person',
          alternateName: 'TestUser3',
          description: 'Test user with object identity',
          homeLocation: { name: 'Bitcoin' },
        },
        identityTxId: 'test3identitytx',
        block: 697161,
        timestamp: Math.floor(Date.now() / 1000),
        valid: true,
      },
    ];

    // Save test identities to Redis
    for (const identity of testIdentities) {
      const key = `signer-${identity.idKey}`;
      await saveToRedis(key, {
        type: 'signer',
        value: identity,
      });
      console.log(`Saved test identity with key: ${key}`);
    }

    // Verify data was saved
    console.log('\nVerifying saved data...');
    const savedKeys = await client.keys('signer-test*');
    console.log('Found keys:', savedKeys);

    for (const key of savedKeys) {
      const value = await client.get(key);
      console.log(`\nData for ${key}:`, value);
    }

    console.log('\nTest completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await client.quit();
  }
}

testRedisConnection().catch(console.error);
