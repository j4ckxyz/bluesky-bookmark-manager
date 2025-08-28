export interface BlueskyPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  record: {
    text: string;
    createdAt: string;
    reply?: {
      root: {
        uri: string;
        cid: string;
      };
      parent: {
        uri: string;
        cid: string;
      };
    };
  };
  embed?: {
    $type: string;
    [key: string]: any;
  };
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  indexedAt: string;
}

// Constellation types removed; now using Bluesky AppView only.

export interface UserSession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}
