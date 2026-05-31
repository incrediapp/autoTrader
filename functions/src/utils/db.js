const admin = require('firebase-admin');

let initialized = false;

function initFirebase() {
  if (!initialized) {
    admin.initializeApp();
    initialized = true;
  }
}

initFirebase();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

function getDb() {
  return db;
}

module.exports = {
  admin,
  db,
  getDb,
  FieldValue,
  Timestamp,
  initFirebase,
};
