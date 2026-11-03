export interface MobileStatus {
  enabled: boolean;
  endpoint?: string;
  certificateSHA256?: string;
  sessions: { id: string; expiresAt: number }[];
  invitation?: { id: string; expiresAt: number };
}
export interface MobileInvitation {
  version: 2;
  endpoint: string;
  certificateSHA256: string;
  hostId: string;
  hostName: string;
  id: string;
  secret: string;
  expiresAt: number;
}

export interface LocalPairingStatus {
  available: boolean; reason: string; enabled: boolean; endpoint?: string; issuerId?: string;
  pending?: { requestId: string; keyHash: string; expires: number; approved: boolean } | null;
  active?: { requestId: string; keyHash: string } | null;
}
export interface LocalPairingInvitation {
  version: 3; endpoint: string; hostId: string; rootCertificate: string;
  invitationId: string; secret: string; expires: number; workspaceHostId: string; hostName: string;
}
