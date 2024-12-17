import { client, saveToRedis } from '../cache.js';
import type { BapIdentity } from '../bap.js';

async function testRedisConnection() {
  try {
    // Test Redis connection
    console.log("Testing Redis connection...");
    await client.connect();
    
    if (!client.isReady) {
      throw new Error("Redis client is not ready");
    }
    
    console.log("Redis connection successful!");

    // Clear existing test data
    const existingKeys = await client.keys("signer-test*");
    if (existingKeys.length > 0) {
      console.log("Clearing existing test data...");
      await Promise.all(existingKeys.map(key => client.del(key)));
    }

    // Insert test data
    console.log("Inserting test data...");
    const testIdentities: BapIdentity[] = [
      {
        idKey: "test1",
        rootAddress: "test1root",
        currentAddress: "test1current",
        addresses: [{ address: "test1addr", txId: "test1tx" }],
        identity: "Test User 1",
        identityTxId: "test1identitytx",
        block: 1000,
        timestamp: Date.now(),
        valid: true
      },
      {
        idKey: "test2",
        rootAddress: "test2root",
        currentAddress: "test2current",
        addresses: [{ address: "test2addr", txId: "test2tx" }],
        identity: "Test User 2",
        identityTxId: "test2identitytx",
        block: 1001,
        timestamp: Date.now(),
        valid: true
      }
    ];

    // Save test identities to Redis
    for (const identity of testIdentities) {
      const key = `signer-${identity.idKey}`;
      await saveToRedis(key, {
        type: "signer",
        value: identity
      });
      console.log(`Saved test identity with key: ${key}`);
    }

    // Verify data was saved
    console.log("\nVerifying saved data...");
    const savedKeys = await client.keys("signer-test*");
    console.log("Found keys:", savedKeys);

    for (const key of savedKeys) {
      const value = await client.get(key);
      console.log(`\nData for ${key}:`, value);
    }

    console.log("\nTest completed successfully!");
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await client.quit();
  }
}

testRedisConnection().catch(console.error); 