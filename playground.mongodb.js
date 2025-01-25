// For messages (if needed)
const messageQuery = {
  'MAP.type': 'message',
  'MAP.bapID': 'Go8vCHAa4S6AhXKTABGpANiz35J',
};

print('\nMessage Relationships:');
const messageRelationships = db.message.find(messageQuery).toArray();
printjson(messageRelationships.map((msg) => msg.MAP));
