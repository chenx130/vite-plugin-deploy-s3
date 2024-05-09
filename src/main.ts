import type { Plugin } from 'vite'
import { normalizePath, createLogger } from 'vite'
import { extname, isAbsolute, join, relative } from 'node:path';
import fg from 'fast-glob'
import { S3, ObjectCannedACL } from '@aws-sdk/client-s3'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mime from 'mime-types'
import { gzip, type ZlibOptions } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

export interface S3Options {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    prefix: string;
}


export interface DeployOptions {

    s3: S3Options;

    /**
     * Remove the .html suffix from the file name
     */
    cleanHtmlSuffix?: boolean;

    /**
     * Delete files that have a specific tag
     */
    deleteUseTag?: string | { key: string, value: string }


    /**
     * Enable gzip compression
     */
    gzip?: boolean | Pick<ZlibOptions, 'level' | 'memLevel' | 'strategy'>;

}


export default function deploy(options: DeployOptions): Plugin {

    let deleteUseTag: { key: string; value: string; } | undefined;

    if (options.deleteUseTag) {
        if (typeof options.deleteUseTag === 'string') {
            deleteUseTag = { key: options.deleteUseTag, value: options.deleteUseTag }
        } else {
            deleteUseTag = options.deleteUseTag
        }

        if (!deleteUseTag.key) {
            throw new Error('deleteUseTag.key is required')
        }

        if (!deleteUseTag.value) {
            throw new Error('deleteUseTag.value is required')
        }
    }

    if (!options.s3 || !options.s3.accessKeyId
        || !options.s3.secretAccessKey
        || !options.s3.bucket
        || !options.s3.region
        || !options.s3.endpoint
        || !options.s3.prefix) {
        throw new Error('s3 options are required')
    }

    // replace {\w+} with options.s3.bucket
    let _endpoint = options.s3.endpoint.replace(/\{(\w+)\}/g, (_, key) => {
        const value = options.s3[key as keyof S3Options];
        if(typeof value !== 'string') {
            throw new Error(`s3.${key} is required`)
        }
        return value
    })

    if(!_endpoint.startsWith('https://')) {
        throw new Error('endpoint must be a valid url')
    }

    if(!_endpoint.endsWith('/')) {
        _endpoint += '/'
    }


    let _outDir: string;

    const logger = createLogger('info', { prefix: '[vite-plugin-deploy]' })

    async function getFiles(): Promise<string[]> {
        return await fg(['**/*'], { cwd: _outDir, onlyFiles: true, absolute: true })
    }


    return {
        name: 'vite-plugin-deploy',
        apply: 'build',

        config() {
            return {
                base: `${_endpoint}${options.s3.prefix}`,
            }
        },

        configResolved(config) {
            _outDir = normalizePath(isAbsolute(config.build.outDir) ? config.build.outDir : join(config.root, config.build.outDir));
        },


        async writeBundle() {

            const client = new Client(options.s3)

            const files = await getFiles()

            const fingerprints = (await client.getJson<FileFingerprintMap>('fingerprints.json')) ?? {};
            const newFingerprints: FileFingerprintMap = {}

            for (const file of files) {
                let name = normalizePath(relative(_outDir, file))

                if (options.cleanHtmlSuffix && name.endsWith('.html')) {
                    name = name.slice(0, -5)
                }

                if (fingerprints[name]) {
                    fingerprints[name].__processed = true
                }
                const h = await hash(file)

                newFingerprints[name] = {
                    hash: h
                }

                if (fingerprints[name]?.hash !== h) {
                    const meta = getFileMeta(file)
                    let data = await readFile(file)

                    if (!file.endsWith('.html') && options.gzip) {
                        data = await gzipAsync(data, typeof options.gzip === 'object' ? options.gzip : undefined)
                        meta.contentEncoding = 'gzip'
                        logger.info(`Compressed: ${name}(size: ${Buffer.byteLength(data)} bytes)`)
                    }

                    await client.put(name, data, meta)
                    logger.info(`Uploaded: ${name}`)
                }
            }

            for (const key in fingerprints) {
                if (!fingerprints[key].__processed) {
                    if (deleteUseTag) {
                        await client.tag(key, deleteUseTag.key, deleteUseTag.value)
                    } else {
                        await client.del(key)
                    }

                    logger.info(`Deleted: ${key}`)
                }
            }

            await client.put('fingerprints.json', JSON.stringify(newFingerprints), {
                contentType: 'application/json',
                acl: ObjectCannedACL.private
            })

            logger.info('Deployed')
        }
    }
}

async function hash(path: string) {
    const data = await readFile(path)
    return createHash('sha256').update(data).digest('hex')
}



class Client {

    private _client: S3;

    constructor(private _options: S3Options) {
        this._client = new S3({
            region: _options.region,
            credentials: {
                accessKeyId: _options.accessKeyId,
                secretAccessKey: _options.secretAccessKey
            }
        })
    }


    async getJson<T>(key: string) {
        const r = await this.get(key)
        if (r === undefined) {
            return undefined
        }
        return JSON.parse(Buffer.from(r).toString('utf-8')) as T
    }


    async get(key: string) {
        try {
            const r = await this._client.getObject({
                Bucket: this._options.bucket,
                Key: this.normalizeKey(key)
            });

            return await r.Body!.transformToByteArray()

        } catch (err) {
            if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'AccessDenied')) {
                return undefined
            }
            throw err;
        }
    }

    async put(key: string, body: Uint8Array | string, options?: PutObjectOptions) {
        await this._client.putObject({
            Bucket: this._options.bucket,
            Key: this.normalizeKey(key),
            Body: body,
            ContentType: options?.contentType,
            ContentLength: Buffer.byteLength(body),
            CacheControl: options?.cacheControl,
            ACL: options?.acl,
            ContentEncoding: options?.contentEncoding,
        })
    }

    async del(key: string) {
        await this._client.deleteObject({
            Bucket: this._options.bucket,
            Key: this.normalizeKey(key)
        })
    }

    async tag(key: string, tagKey: string, tagValue: string) {
        try {
            await this._client.putObjectTagging({
                Bucket: this._options.bucket,
                Key: this.normalizeKey(key),
                Tagging: {
                    TagSet: [
                        {
                            Key: tagKey,
                            Value: tagValue
                        }
                    ]
                }
            })
        } catch (err) {
            if (err instanceof Error && err.name === 'NoSuchKey') {
                return
            }
            throw err
        }
    }

    normalizeKey(key: string) {
        return this._options.prefix + (key.startsWith('/') ? key : `/${key}`)
    }

}


function getFileMeta(file: string): PutObjectOptions {

    const ext = extname(file)
    const contentType = mime.lookup(ext)

    const options: PutObjectOptions = {
        contentType: typeof contentType === 'string' ? contentType : 'application/octet-stream'
    }
    if (!file.endsWith('.html')) {
        options.cacheControl = 'public, max-age=31536000, immutable'
    }
    options.acl = ObjectCannedACL.public_read
    return options
}


interface PutObjectOptions {
    contentType?: string
    contentEncoding?: string
    cacheControl?: string
    acl?: ObjectCannedACL
}


interface FileFingerprint {

    hash: string

    __processed?: boolean
}

interface FileFingerprintMap {
    [key: string]: FileFingerprint
}