import { serverApi } from './api.js';

const listeners = new Set();
let currentUser = null;
let serverReachable = true;

export async function initSession() {
  try {
    currentUser = (await serverApi.me()).user;
    serverReachable = true;
  } catch (error) {
    currentUser = null;
    serverReachable = error.status === 401;
  }
  emit();
  return sessionSnapshot();
}

export function sessionSnapshot() { return { user: currentUser, serverReachable }; }
export function isAuthenticated() { return !!currentUser; }
export function onSessionChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export async function login(input) {
  currentUser = (await serverApi.login(input)).user;
  serverReachable = true;
  emit();
  return currentUser;
}

export async function register(input) {
  currentUser = (await serverApi.register(input)).user;
  serverReachable = true;
  emit();
  return currentUser;
}

export async function logout() {
  try { await serverApi.logout(); } finally { currentUser = null; emit(); }
}

function emit() { const snapshot = sessionSnapshot(); for (const listener of listeners) listener(snapshot); }
