import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const testPath=join(tmpdir(),`personal-ledger-vitest-${process.pid}.db`);
for(const suffix of ["","-wal","-shm"])rmSync(`${testPath}${suffix}`,{force:true});
process.env.DATABASE_PATH=testPath;process.env.APP_TIMEZONE="Asia/Hong_Kong";
