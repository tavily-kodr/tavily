export class Deduplicator {
  private readonly seenUrls = new Set<string>();
  private readonly seenContentHashes = new Set<string>();

  public isUrlSeen(normalizedUrl: string): boolean {
    return this.seenUrls.has(normalizedUrl);
  }

  public markUrlSeen(normalizedUrl: string): boolean {
    if (this.seenUrls.has(normalizedUrl)) {
      return false;
    }
    this.seenUrls.add(normalizedUrl);
    return true;
  }

  public isContentSeen(contentHash: string): boolean {
    return this.seenContentHashes.has(contentHash);
  }

  public markContentSeen(contentHash: string): boolean {
    if (this.seenContentHashes.has(contentHash)) {
      return false;
    }
    this.seenContentHashes.add(contentHash);
    return true;
  }

  public get urlCount(): number {
    return this.seenUrls.size;
  }

  public get contentCount(): number {
    return this.seenContentHashes.size;
  }

  public clear(): void {
    this.seenUrls.clear();
    this.seenContentHashes.clear();
  }
}
