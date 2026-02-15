export interface SecretProvider {
  readonly name: string;
  load(): Promise<Record<string, string>>;
  list(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
