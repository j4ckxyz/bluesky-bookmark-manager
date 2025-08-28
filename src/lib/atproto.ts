import { ObjectParser } from "@pilcrowjs/object-parser";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import { createJWTSignatureMessage, encodeJWT } from "@oslojs/jwt";
import { joinURIBaseAndPath, readAllStreamWithLimit, createECDSAPublicKeyJWK } from "./utils";
export { joinURIBaseAndPath } from "./utils";

export async function resolveATProtoHandle(handle: string): Promise<string> {
  // 1) Prefer public AppView (CORS-friendly and reliable)
  try {
    const url = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
    const appviewRes = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (appviewRes.ok && appviewRes.body !== null) {
      const bytes = await readAllStreamWithLimit(appviewRes.body, 1024 * 32);
      const j = JSON.parse(new TextDecoder().decode(bytes));
      const p = new ObjectParser(j);
      if (p.has("did")) {
        const did = p.getString("did");
        if (did.startsWith("did:")) {
          return did;
        }
      }
    } else if (appviewRes.body !== null) {
      appviewRes.body.cancel();
    }
  } catch {}

  // 2) DNS TXT via DoH
  const txtParams = new URLSearchParams();
  txtParams.set("name", `_atproto.${handle}`);
  txtParams.set("type", "TXT");
  const txtRequest = new Request(
    "https://cloudflare-dns.com/dns-query" + "?" + txtParams.toString(),
  );
  txtRequest.headers.set("Accept", "application/dns-json");
  const txtFetchPromise = fetch(txtRequest, {
    signal: AbortSignal.timeout(5000),
  });
  // 3) Well-known
  const wellknownFetchPromise = fetch(
    joinURIBaseAndPath(`https://${handle}`, "/.well-known/atproto-did"),
    {
      signal: AbortSignal.timeout(5000),
    },
  );

  const [txtFetchResult, wellknownFetchResult] = await Promise.allSettled([
    txtFetchPromise,
    wellknownFetchPromise,
  ]);
  
  if (txtFetchResult.status === "fulfilled") {
    if (txtFetchResult.value.status === 200 && txtFetchResult.value.body !== null) {
      // 32KB limit
      const resolverResultBytes = await readAllStreamWithLimit(
        txtFetchResult.value.body,
        1024 * 32,
      );
      const resolverResult = JSON.parse(new TextDecoder().decode(resolverResultBytes));
      const resolverResultParser = new ObjectParser(resolverResult);
      if (resolverResultParser.has("Answer")) {
        // Try each TXT answer until one parses to a valid did
        try {
          const answers = resolverResultParser.getArray("Answer");
          for (let i = 0; i < answers.length; i++) {
            const answerParser = new ObjectParser(answers[i]);
            const dnsRecord = answerParser.getString("data");
            try {
              const did = parseATProtoTXTDNSRecord(dnsRecord);
              if (did && did.startsWith("did:")) {
                return did;
              }
            } catch {}
          }
        } catch {}
      }
    } else if (txtFetchResult.value.body !== null) {
      txtFetchResult.value.body.cancel();
    }
  }

  if (wellknownFetchResult.status === "fulfilled") {
    if (wellknownFetchResult.value.status === 200 && wellknownFetchResult.value.body !== null) {
      // 32KB limit
      const wellknownResultBytes = await readAllStreamWithLimit(
        wellknownFetchResult.value.body,
        1024 * 32,
      );
      const maybeDid = new TextDecoder().decode(wellknownResultBytes).trim();
      if (maybeDid.startsWith("did:")) {
        return maybeDid;
      }
    } else if (wellknownFetchResult.value.body !== null) {
      wellknownFetchResult.value.body.cancel();
    }
  }
  throw new Error("Failed to resolve handle");
}

function parseATProtoTXTDNSRecord(record: string): string {
  if (!record.startsWith('"') || !record.endsWith('"')) {
    throw new Error("Unexpected record value");
  }
  const keyValue = record.slice(1, -1);
  const parts = keyValue.split("=");
  if (parts.length !== 2) {
    throw new Error("Unexpected record value");
  }
  if (parts[0] !== "did") {
    throw new Error("Unexpected record value");
  }
  return parts[1];
}

export async function getPDSFromAccountDID(did: string): Promise<string> {
  let pdsEndpoint: string;
  if (did.startsWith("did:plc:")) {
    pdsEndpoint = await getPDSFromAccountPLCDID(did);
  } else if (did.startsWith("did:web:")) {
    pdsEndpoint = await getPDSFromAccountWebDID(did);
  } else {
    throw new Error("Unknown DID format");
  }
  return pdsEndpoint;
}

export async function getPDSFromAccountWebDID(did: string): Promise<string> {
  const prefix = "did:web:";
  if (!did.startsWith(prefix)) {
    throw new Error("Invalid Web DID");
  }
  let target = did.slice(prefix.length);
  target = target.replaceAll(":", "/");
  target = decodeURIComponent(target);

  const response = await fetch(joinURIBaseAndPath(`https://${target}`, "/.well-known/did.json"), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    if (response.body !== null) {
      response.body.cancel();
    }
    throw new Error("Invalid DID");
  }
  if (response.body === null) {
    throw new Error("Unexpected response");
  }
  // 32KB limit
  const resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
  const result = JSON.parse(new TextDecoder().decode(resultBytes));
  const resultParser = new ObjectParser(result);
  const serviceResults = resultParser.getArray("service");
  for (let i = 0; i < serviceResults.length; i++) {
    const serviceResultParser = new ObjectParser(serviceResults[i]);
    if (serviceResultParser.getString("id") === "#atproto_pds") {
      return serviceResultParser.getString("serviceEndpoint");
    }
  }
  throw new Error("Failed to get PDS");
}

export async function getPDSFromAccountPLCDID(did: string): Promise<string> {
  const response = await fetch(joinURIBaseAndPath("https://plc.directory", did), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    if (response.body !== null) {
      response.body.cancel();
    }
    throw new Error("Invalid DID");
  }
  if (response.body === null) {
    throw new Error("Unexpected response");
  }
  // 32KB limit
  const resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
  const result = JSON.parse(new TextDecoder().decode(resultBytes));
  const resultParser = new ObjectParser(result);
  const serviceResults = resultParser.getArray("service");
  for (let i = 0; i < serviceResults.length; i++) {
    const serviceResultParser = new ObjectParser(serviceResults[i]);
    if (serviceResultParser.getString("id") === "#atproto_pds") {
      return serviceResultParser.getString("serviceEndpoint");
    }
  }
  throw new Error("Failed to get PDS");
}

export async function getAuthorizationServer(pdsEndpoint: string): Promise<string> {
  // 1) Try describeServer for explicit OAuth issuer
  try {
    const response = await fetch(
      joinURIBaseAndPath(pdsEndpoint, "/xrpc/com.atproto.server.describeServer"),
      { signal: AbortSignal.timeout(5000) },
    );
    if (response.ok) {
      if (response.body === null) {
        throw new Error("Unexpected response");
      }
      const resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
      const result = JSON.parse(new TextDecoder().decode(resultBytes));
      const resultParser = new ObjectParser(result);
      if (resultParser.has("oauth", "issuer")) {
        return resultParser.getString("oauth", "issuer");
      }
    } else {
      if (response.body !== null) {
        response.body.cancel();
      }
    }
  } catch {}

  // 2) Fallback to the well-known oauth-protected-resource to discover issuer list
  try {
    const wellKnown = await fetch(
      joinURIBaseAndPath(pdsEndpoint, "/.well-known/oauth-protected-resource"),
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (wellKnown.ok && wellKnown.body !== null) {
      const bytes = await readAllStreamWithLimit(wellKnown.body, 1024 * 32);
      const j = JSON.parse(new TextDecoder().decode(bytes));
      const p = new ObjectParser(j);
      if (p.has("authorization_servers")) {
        const list = p.getArray("authorization_servers").map(String);
        if (list.length > 0) {
          return list[0];
        }
      }
    } else if (wellKnown.body !== null) {
      wellKnown.body.cancel();
    }
  } catch {}

  throw new Error("Failed to get authorization server");
}

export interface ATProtoAuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  pushedAuthorizationRequestEndpoint: string;
  jwksUri?: string;
  responseTypesSupported: string[];
  grantTypesSupported: string[];
  responseModesSupported?: string[];
  scopesSupported?: string[];
  authorizationResponseIssParameterSupported?: boolean;
  requirePushedAuthorizationRequests: boolean;
  pushedAuthorizationRequestEndpointAuthMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  dpopSigningAlgValuesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

export async function getATProtoAuthorizationServerMetadata(
  authorizationServerIssuer: string,
): Promise<ATProtoAuthorizationServerMetadata> {
  const response = await fetch(
    joinURIBaseAndPath(authorizationServerIssuer, "/.well-known/oauth-authorization-server"),
    {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) {
    if (response.body !== null) {
      response.body.cancel();
    }
    throw new Error("Failed to get authorization server metadata");
  }
  if (response.body === null) {
    throw new Error("Unexpected response");
  }
  // 32KB limit
  const resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
  const result = JSON.parse(new TextDecoder().decode(resultBytes));
  const resultParser = new ObjectParser(result);
  const metadata: ATProtoAuthorizationServerMetadata = {
    issuer: resultParser.getString("issuer"),
    authorizationEndpoint: resultParser.getString("authorization_endpoint"),
    tokenEndpoint: resultParser.getString("token_endpoint"),
    pushedAuthorizationRequestEndpoint: resultParser.getString(
      "pushed_authorization_request_endpoint",
    ),
    responseTypesSupported: resultParser.getArray("response_types_supported").map(String),
    grantTypesSupported: resultParser.getArray("grant_types_supported").map(String),
    requirePushedAuthorizationRequests: resultParser.getBoolean(
      "require_pushed_authorization_requests",
    ),
  };
  if (resultParser.has("jwks_uri")) {
    metadata.jwksUri = resultParser.getString("jwks_uri");
  }
  if (resultParser.has("response_modes_supported")) {
    metadata.responseModesSupported = resultParser.getArray("response_modes_supported").map(String);
  }
  if (resultParser.has("scopes_supported")) {
    metadata.scopesSupported = resultParser.getArray("scopes_supported").map(String);
  }
  if (resultParser.has("authorization_response_iss_parameter_supported")) {
    metadata.authorizationResponseIssParameterSupported = resultParser.getBoolean(
      "authorization_response_iss_parameter_supported",
    );
  }
  if (resultParser.has("pushed_authorization_request_endpoint_auth_methods_supported")) {
    metadata.pushedAuthorizationRequestEndpointAuthMethodsSupported = resultParser
      .getArray("pushed_authorization_request_endpoint_auth_methods_supported")
      .map(String);
  }
  if (resultParser.has("token_endpoint_auth_methods_supported")) {
    metadata.tokenEndpointAuthMethodsSupported = resultParser
      .getArray("token_endpoint_auth_methods_supported")
      .map(String);
  }
  if (resultParser.has("dpop_signing_alg_values_supported")) {
    metadata.dpopSigningAlgValuesSupported = resultParser
      .getArray("dpop_signing_alg_values_supported")
      .map(String);
  }
  if (resultParser.has("code_challenge_methods_supported")) {
    metadata.codeChallengeMethodsSupported = resultParser
      .getArray("code_challenge_methods_supported")
      .map(String);
  }
  return metadata;
}

export function createLocalhostATProtoOAuthClient(
  authorizationServerIssuer: string,
  redirectURI: string,
  allowedOptionalScopes: string[],
): ATProtoOAuthClient {
  // Bluesky/ATProto dev flow: many issuers accept a special localhost client_id format
  // Use exact host "http://localhost" (no port, no path) with query parameters for redirect_uri and scope.
  // Redirect URI should still use loopback IP (127.0.0.1) per RFC 8252.
  const clientIdParams = new URLSearchParams();
  clientIdParams.set("redirect_uri", redirectURI);
  clientIdParams.set("scope", ["atproto", ...allowedOptionalScopes].join(" "));
  const clientId = `http://localhost?${clientIdParams.toString()}`;
  const client = new ATProtoOAuthClient(authorizationServerIssuer, clientId, redirectURI, null);
  return client;
}

export interface CryptoKeyPairWithId extends CryptoKeyPair {
  id: string;
}

export class ATProtoOAuthClient {
  private authorizationServerIssuer: string;
  private clientId: string;
  private redirectURI: string;
  private keyPair: CryptoKeyPairWithId | null;

  constructor(
    authorizationServerIssuer: string,
    clientId: string,
    redirectURI: string,
    keyPair: CryptoKeyPairWithId | null,
  ) {
    this.authorizationServerIssuer = authorizationServerIssuer;
    this.clientId = clientId;
    this.redirectURI = redirectURI;
    this.keyPair = keyPair;
  }

  public async createAuthorizationURL(
    pushedAuthorizationRequestEndpoint: string,
    authorizationEndpoint: string,
    state: string,
    codeVerifier: string,
    optionalScopes: string[],
    dpopKeyPair: CryptoKeyPair,
  resource: string,
    loginHint?: string,
  ): Promise<URL> {
    const codeChallengeBytes = await sha256(new TextEncoder().encode(codeVerifier));
    const codeChallenge = encodeBase64urlNoPadding(codeChallengeBytes);
    const scopeParameter = ["atproto", ...optionalScopes].join(" ");
    const body = new URLSearchParams();
    body.set("response_type", "code");
    body.set("client_id", this.clientId);
    body.set("redirect_uri", this.redirectURI);
    body.set("state", state);
    body.set("code_challenge_method", "S256");
    body.set("code_challenge", codeChallenge);
  body.set("scope", scopeParameter);
  // Request a token intended for the user's PDS (resource indicator RFC 8707)
  body.set("resource", resource);
    if (this.keyPair !== null) {
      const clientAssertion = await createClientAssertion(
        this.keyPair,
        this.clientId,
        this.authorizationServerIssuer,
      );
      body.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      body.set("client_assertion", clientAssertion);
    }
    if (loginHint) {
      body.set("login_hint", loginHint);
    }
    
    const request = new Request(pushedAuthorizationRequestEndpoint, {
      method: "POST",
      body,
    });
    request.headers.set("Content-Type", "application/x-www-form-urlencoded");
    request.headers.set("Accept", "application/json");
    
    // Debug logging (dev only)
    if (import.meta.env.DEV) {
      console.log(`[OAuth] PAR request to: ${pushedAuthorizationRequestEndpoint}`);
      console.log(`[OAuth] PAR client_id: ${body.get("client_id")}`);
      console.log(`[OAuth] PAR redirect_uri: ${body.get("redirect_uri")}`);
      console.log(`[OAuth] PAR scope: ${body.get("scope")}`);
      console.log(`[OAuth] PAR resource: ${body.get("resource")}`);
      console.log(`[OAuth] PAR login_hint: ${body.get("login_hint")}`);
    }
    
    // Use sendOAuthRequest to handle DPoP nonce challenges properly
    const [response, _] = await sendOAuthRequest(dpopKeyPair, request, null);
    
    if (response.body === null) {
      throw new Error("Unexpected response");
    }
    const resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
    const result = JSON.parse(new TextDecoder().decode(resultBytes));
    const resultParser = new ObjectParser(result);
    const requestURI = resultParser.getString("request_uri");

    const authorizationRequestURL = new URL(authorizationEndpoint);
    authorizationRequestURL.searchParams.set("client_id", this.clientId);
    authorizationRequestURL.searchParams.set("request_uri", requestURI);
    return authorizationRequestURL;
  }

  public async validateAuthorizationCode(
    tokenEndpoint: string,
    dpopKeyPair: CryptoKeyPair,
    code: string,
    codeVerifier: string,
    resource?: string,
  ): Promise<[tokens: ATProtoOAuthTokens, dpopNonce: string | null]> {
    let body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", this.clientId);
    body.set("code", code);
    body.set("code_verifier", codeVerifier);
    body.set("redirect_uri", this.redirectURI);
    if (resource) {
      body.set("resource", resource);
    }
    if (this.keyPair !== null) {
      const clientAssertion = await createClientAssertion(
        this.keyPair,
        this.clientId,
        this.authorizationServerIssuer,
      );
      body.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      body.set("client_assertion", clientAssertion);
    }
    let request = new Request(tokenEndpoint, {
      method: "POST",
      body,
    });
    request.headers.set("Content-Type", "application/x-www-form-urlencoded");
    request.headers.set("Accept", "application/json");
    const [successfulResponse, dpopNonce] = await sendOAuthRequest(dpopKeyPair, request, null);
    if (successfulResponse.body === null) {
      throw new Error("Unexpected response");
    }
    const resultBytes = await readAllStreamWithLimit(successfulResponse.body, 1024 * 32);
    const result = JSON.parse(new TextDecoder().decode(resultBytes));
    const tokens = parseOAuthTokensResult(result);
    return [tokens, dpopNonce];
  }
}

function parseOAuthTokensResult(result: unknown): ATProtoOAuthTokens {
  let resultParser = new ObjectParser(result);

  const did = resultParser.getString("sub");
  const accessToken = resultParser.getString("access_token");

  let accessTokenExpiresInSeconds: number | null = null;
  if (resultParser.has("refresh_token")) {
    accessTokenExpiresInSeconds = resultParser.getNumber("expires_in");
  }
  let refreshToken: string | null = null;
  if (resultParser.has("refresh_token")) {
    refreshToken = resultParser.getString("refresh_token");
  }
  let accessTokenExpiresAt: Date | null = null;
  if (accessTokenExpiresInSeconds !== null) {
    accessTokenExpiresAt = new Date(Date.now() + accessTokenExpiresInSeconds * 1000);
  }
  const tokens: ATProtoOAuthTokens = {
    did,
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
  };
  return tokens;
}

export interface ATProtoOAuthTokens {
  did: string;
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await window.crypto.subtle.digest("SHA-256", copy);
  return new Uint8Array(digest);
}

async function createClientAssertion(
  keyPair: CryptoKeyPairWithId,
  clientId: string,
  authorizationServerIssuer: string,
): Promise<string> {
  const bytes = new Uint8Array(20);
  window.crypto.getRandomValues(bytes);
  const headerJSON = JSON.stringify({
    typ: "JWT",
    alg: "ES256",
    kid: keyPair.id,
  });
  const issuedAtUnix = Math.floor(Date.now() / 1000);
  const payloadJSON = JSON.stringify({
    iss: clientId,
    sub: clientId,
    aud: authorizationServerIssuer,
    jti: encodeBase64urlNoPadding(bytes),
    iat: issuedAtUnix,
    exp: issuedAtUnix + 60,
  });
  const message = createJWTSignatureMessage(headerJSON, payloadJSON);
  const messageCopy = new Uint8Array(message.byteLength);
  messageCopy.set(message);
  const signature = await window.crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    keyPair.privateKey,
    messageCopy,
  );
  const dpop = encodeJWT(headerJSON, payloadJSON, new Uint8Array(signature));
  return dpop;
}

export async function createDPOP(
  keyPair: CryptoKeyPair,
  requestMethod: string,
  requestURL: string,
  nonce: string | null,
  attributes: object,
): Promise<string> {
  const bytes = new Uint8Array(20);
  window.crypto.getRandomValues(bytes);
  const publicKeyJWK = await createECDSAPublicKeyJWK(keyPair.publicKey);
  const headerJSON = JSON.stringify({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicKeyJWK,
  });
  const payloadJSON = JSON.stringify({
    ...attributes,
    jti: encodeBase64urlNoPadding(bytes),
    htm: requestMethod,
    htu: requestURL.split("?")[0],
    iat: Math.floor(Date.now() / 1000),
    nonce: nonce ?? undefined,
  });
  const message = createJWTSignatureMessage(headerJSON, payloadJSON);
  const messageCopy2 = new Uint8Array(message.byteLength);
  messageCopy2.set(message);
  const signature = await window.crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    keyPair.privateKey,
    messageCopy2,
  );
  const dpop = encodeJWT(headerJSON, payloadJSON, new Uint8Array(signature));
  return dpop;
}

async function sendOAuthRequest(
  dpopKeyPair: CryptoKeyPair,
  request: Request,
  dpopNonce: string | null,
): Promise<[response: Response, nonce: string | null]> {
  if (import.meta.env.DEV) {
    console.log(`[OAuth] Sending ${request.method} request to: ${request.url}`);
    console.log(`[OAuth] Initial DPoP nonce: ${dpopNonce}`);
  }
  
  const clonedRequest = request.clone();
  let dpop = await createDPOP(dpopKeyPair, request.method, request.url, dpopNonce, {});
  request.headers.set("DPoP", dpop);
  let response = await fetch(request, {
    signal: AbortSignal.timeout(5000),
  });
  let newDPOPNonce = response.headers.get("DPoP-Nonce");
  if (newDPOPNonce !== null) {
  if (import.meta.env.DEV) console.log(`[OAuth] Received new DPoP nonce: ${newDPOPNonce}`);
    dpopNonce = newDPOPNonce;
  }
  if (response.ok) {
  if (import.meta.env.DEV) console.log(`[OAuth] Request successful: ${response.status}`);
    return [response, dpopNonce];
  }
  if (response.body == null) {
    throw new Error("Unexpected response");
  }

  // 32KB limit
  let resultBytes = await readAllStreamWithLimit(response.body, 1024 * 32);
  let result = JSON.parse(new TextDecoder().decode(resultBytes));
  let resultParser = new ObjectParser(result);
  let errorDescription = resultParser.getString("error_description");

  if (import.meta.env.DEV) console.log(`[OAuth] Request failed: ${response.status} - ${errorDescription}`);

  // Check for DPoP nonce requirement - handle multiple possible error messages
  const requiresDpopNonce = (response.status === 400) && 
    (errorDescription === "use_dpop_nonce" || 
     errorDescription === "Authorization server requires nonce in DPoP proof" ||
     errorDescription.toLowerCase().includes("nonce"));

  if (requiresDpopNonce) {
  if (import.meta.env.DEV) console.log(`[OAuth] Server requires DPoP nonce, retrying with nonce`);
    let dpopNonce = response.headers.get("DPoP-Nonce");
    if (dpopNonce === null) {
      throw new Error("Unexpected response");
    }
  if (import.meta.env.DEV) console.log(`[OAuth] Using DPoP nonce for retry: ${dpopNonce}`);
    let dpop = await createDPOP(dpopKeyPair, clonedRequest.method, clonedRequest.url, dpopNonce, {});
    clonedRequest.headers.set("DPoP", dpop);
    let retryResponse = await fetch(clonedRequest, {
      signal: AbortSignal.timeout(5000),
    });
    if (retryResponse.ok) {
  if (import.meta.env.DEV) console.log(`[OAuth] Retry request successful: ${retryResponse.status}`);
      return [retryResponse, dpopNonce];
    }
    // Log retry failure details
    let retryErrorBody = 'Unknown error';
    try {
      if (retryResponse.body !== null) {
        const retryErrorBytes = await readAllStreamWithLimit(retryResponse.body, 1024 * 32);
        retryErrorBody = new TextDecoder().decode(retryErrorBytes);
      }
    } catch {
      if (retryResponse.body !== null) {
        retryResponse.body.cancel();
      }
    }
    if (import.meta.env.DEV) {
      console.error(`[OAuth] Retry request failed: ${retryResponse.status} ${retryResponse.statusText}`);
      console.error(`[OAuth] Retry error body:`, retryErrorBody);
    }
    throw new Error(`PAR request failed: ${retryResponse.status} ${retryResponse.statusText} - ${retryErrorBody}`);
  }
  
  // For other errors, throw with the detailed error description
  throw new Error(`OAuth request failed: ${response.status} ${response.statusText} - ${errorDescription}`);
}
