export type EnvironmentMode = "local" | "single-node" | "internet-facing";
export type RuntimeStage = "dev" | "test" | "prod";

export interface ApiEndpoints {
  httpBaseUrl: string;
  realtimeUrl: string;
}

export interface DesktopBootstrapConfig {
  environment: EnvironmentMode;
  stage: RuntimeStage;
  endpoints: ApiEndpoints;
}

export interface HealthPayload {
  service: string;
  status: "ok";
  version: string;
}
