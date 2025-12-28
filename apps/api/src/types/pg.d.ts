declare module "pg" {
  export type QueryResult<Row = any> = {
    rows: Row[];
    rowCount: number;
  };

  export class PoolClient {
    query<Row = any>(text: string, values?: any[]): Promise<QueryResult<Row>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: any);
    query<Row = any>(text: string, values?: any[]): Promise<QueryResult<Row>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }

  export class Client {
    constructor(config?: any);
    connect(): Promise<void>;
    query<Row = any>(text: string, values?: any[]): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }
}

