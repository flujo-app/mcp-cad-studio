interface CliOptions {
    transport: "stdio" | "http";
    host: string;
    port: number;
    https: boolean;
    tlsCert?: string;
    tlsKey?: string;
    dataFile: string | null;
}
declare function parseCli(args: string[]): CliOptions;
declare function main(args?: string[]): Promise<void>;

export { main, parseCli };
