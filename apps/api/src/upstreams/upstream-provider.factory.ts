import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import type { Upstream } from "@gateway/database";
import { CredentialCipher, CredentialDecryptionError } from "@gateway/shared";
import type { AIUpstreamProvider } from "./providers/upstream-provider.js";
import { VertexAIProvider, type VertexAuth } from "./providers/vertex-ai.provider.js";
import { upstreamCredentialAssociatedData } from "./upstream-credentials.js";

@Injectable()
export class UpstreamProviderFactory {
  private readonly logger = new Logger(UpstreamProviderFactory.name);

  constructor(private readonly cipher: CredentialCipher) {}

  forUpstream(upstream: Upstream): AIUpstreamProvider {
    if (upstream.provider !== "vertex-ai") {
      throw new InternalServerErrorException("Upstream provider is not supported.");
    }

    return new VertexAIProvider({
      projectId: upstream.projectId,
      location: upstream.location,
      auth: this.authFor(upstream),
    });
  }

  private authFor(upstream: Upstream): VertexAuth {
    if (upstream.authMethod === "application-default-credentials") {
      return { method: "application-default-credentials" };
    }

    const decrypted = this.decryptCredentials(upstream);

    if (upstream.authMethod === "service-account") {
      if (!isRecord(decrypted)) {
        this.fail(upstream.id);
      }
      const clientEmail = decrypted.client_email;
      const privateKey = decrypted.private_key;
      if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
        this.fail(upstream.id);
      }
      const credentials: {
        client_email: string;
        private_key: string;
        [key: string]: unknown;
      } = {
        ...decrypted,
        client_email: clientEmail,
        private_key: privateKey,
      };
      return { method: "service-account", credentials };
    }

    if (upstream.authMethod === "api-key") {
      if (typeof decrypted !== "string") {
        this.fail(upstream.id);
      }
      return { method: "api-key", apiKey: decrypted };
    }

    throw new InternalServerErrorException("Upstream auth method is not supported.");
  }

  private decryptCredentials(upstream: Upstream): unknown {
    if (upstream.encryptedCredentials === null) {
      this.fail(upstream.id);
    }

    try {
      const plaintext = this.cipher.decrypt(
        upstream.encryptedCredentials,
        upstreamCredentialAssociatedData(upstream.id),
      );
      return JSON.parse(plaintext) as unknown;
    } catch (error) {
      this.logger.error(`Failed to decrypt credentials for upstream ${upstream.id}`);
      if (error instanceof CredentialDecryptionError || error instanceof SyntaxError) {
        throw new InternalServerErrorException("Stored credentials could not be decrypted.");
      }
      throw error;
    }
  }

  private fail(upstreamId: string): never {
    this.logger.error(`Failed to decrypt credentials for upstream ${upstreamId}`);
    throw new InternalServerErrorException("Stored credentials could not be decrypted.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
