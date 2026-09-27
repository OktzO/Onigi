import { Mutex } from 'async-mutex';
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Use a Map to store mutexes for each file path
const fileLocks = new Map();
// Get or create a mutex for a specific file path
const getFileLock = (path) => {
    let mutex = fileLocks.get(path);
    if (!mutex) {
        mutex = new Mutex();
        fileLocks.set(path, mutex);
    }
    return mutex;
};
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (folder) => {
    // writeFile() memotong creds.json yang sedang dipakai: crash di tengah
    // write meninggalkan file pendek, dan readData menelan semua error jadi
    // `null` → initAuthCreds(), jadi torn write tidak bisa dibedakan dari
    // "belum pernah pair". Tulis ke .tmp, fsync, lalu rename (atomik di POSIX).
    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const tmpPath = `${filePath}.tmp`;
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                const handle = await open(tmpPath, 'w');
                try {
                    await handle.writeFile(JSON.stringify(data, BufferJSON.replacer));
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                await rename(tmpPath, filePath);
            }
            finally {
                release();
            }
        });
    };
    // ENOENT = memang belum ada file (identitas baru, sah). Semua error lain —
    // EACCES/EMFILE/EIO, EISDIR, JSON rusak — dilempar: state yang rusak
    // ditolak, tidak pernah dipatch.
    const readData = async (file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                const data = await readFile(filePath, { encoding: 'utf-8' });
                return JSON.parse(data, BufferJSON.reviver);
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw new Error(`failed to read auth state file "${filePath}": ${error.message}`, { cause: error });
            }
            finally {
                release();
            }
        });
    };
    const removeData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return mutex.acquire().then(async (release) => {
                try {
                    await unlink(filePath);
                }
                catch {
                }
                finally {
                    release();
                }
            });
        }
        catch { }
    };
    const folderInfo = await stat(folder).catch(() => { });
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
        }
    }
    else {
        await mkdir(folder, { recursive: true });
    }
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
    const creds = (await readData('creds.json')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
//# sourceMappingURL=use-multi-file-auth-state.js.map