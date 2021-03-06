import axios, { Method, AxiosInstance } from "axios";
import {NodeClient} from "@sentry/node";
import Ratelimiter from "./Ratelimiter";
import LocalBucket from "./ratelimitBuckets/LocalBucket";
import Endpoints from "./Endpoints";
import { version } from "../package.json";
import FormData from "form-data";

interface TOptions {
    sentry: NodeClient,
    token: string,
    baseHost: string
}

/**
 * Request Handler class
 * @private
 */
class RequestHandler {


    sentry: NodeClient | null
    latency: number
    remaining: Object
    reset: Object
    limit: Object
    client: AxiosInstance
    options: { baseURL: string, baseHost: string}
    ratelimiter: Ratelimiter


    /**
     * Create a new request handler
     * @param {Ratelimiter} ratelimiter - ratelimiter to use for ratelimiting requests
     * @param {Object} options - options
     * @param {String} options.token - token to use for calling the rest api
     * @constructor
     * @private
     */
    constructor(ratelimiter: Ratelimiter, options: TOptions) {
        this.ratelimiter = ratelimiter;
        this.options = {baseHost: Endpoints.BASE_HOST, baseURL: Endpoints.BASE_URL};
        Object.assign(this.options, options);
        this.client = axios.create({
            baseURL: this.options.baseHost + Endpoints.BASE_URL,
            headers: {
                Authorization: options.token,
                'User-Agent': `DiscordBot (https://github.com/DasWolke/SnowTransfer, ${version})`
            }
        });
        this.sentry = options.sentry ? options.sentry : null;
        this.latency = 500;
        this.remaining = {};
        this.reset = {};
        this.limit = {};
    }

    /**
     * Request a route from the discord api
     * @param {String} endpoint - endpoint to request
     * @param {String} method - http method to use
     * @param {String} [dataType=json] - type of the data being sent
     * @param {Object} [data] - data to send, if any
     * @param {Number} [attempts=0] - Number of attempts of the current request
     * @returns {Promise.<Object>} - Result of the request
     * @protected
     */
    request<T>(endpoint: string, method: Method, dataType: "json" | "multipart" = 'json', data = {}, attempts = 0): Promise<T> {
        return new Promise(async (res, rej) => {
            this.ratelimiter.queue(async (bkt: any) => {
                let request;
                let latency = Date.now();
                try {
                    switch (dataType) {
                        case 'json':
                            request = await this._request(endpoint, method, data, (method === 'get' || endpoint.includes('/bans') || endpoint.includes('/prune')));
                            break;
                        case 'multipart':
                            request = await this._multiPartRequest(endpoint, method, data);
                            break;
                        default:
                            break;
                    }
                    this.latency = Date.now() - latency;
                    //@ts-ignore
                    let offsetDate = this._getOffsetDateFromHeader(request.headers['date']);
                    //@ts-ignore
                    this._applyRatelimitHeaders(bkt, request.headers, offsetDate, endpoint.endsWith('/reactions/:id'));
                    //@ts-ignore
                    if (request.data) {
                        //@ts-ignore
                        return res(request.data);
                    }
                    return res();
                } catch (error) {
                    if (this.sentry) {
                        this.sentry.captureException(error);
                    }
                    if (attempts === 3) {
                        return rej({error: 'Request failed after 3 attempts', request: error});
                    }
                    if (error.response) {
                        let offsetDate = this._getOffsetDateFromHeader(error.response.headers['date']);
                        if (error.response.status === 429) {
                            //TODO WARN ABOUT THIS :< either bug or meme
                            this._applyRatelimitHeaders(bkt, error.response.headers, offsetDate, endpoint.endsWith('/reactions/:id'));
                            return this.request(endpoint, method, dataType, data, attempts ? ++attempts : 1);
                        }
                        if (error.response.status === 502) {
                            return this.request(endpoint, method, dataType, data, attempts ? ++attempts : 1);
                        }
                    }
                    return rej(error);
                }
            }, endpoint, method);
        });

    }

    /**
     * Calculate the time difference between the local server and discord
     * @param {String} dateHeader - Date header value returned by discord
     * @returns {number} - Offset in milliseconds
     * @private
     */
    private _getOffsetDateFromHeader(dateHeader: string) {
        let discordDate = Date.parse(dateHeader);
        let offset = Date.now() - discordDate;
        return Date.now() + offset;
    }

    /**
     * Apply the received ratelimit headers to the ratelimit bucket
     * @param {LocalBucket} bkt - Ratelimit bucket to apply the headers to
     * @param {Object} headers - Http headers received from discord
     * @param {Number} offsetDate - Unix timestamp of the current date + offset to discord time
     * @param {Boolean} reactions - Whether to use reaction ratelimits (1/250ms)
     * @private
     */
    private _applyRatelimitHeaders(bkt: LocalBucket, headers: Object, offsetDate: Number, reactions = false) {
        //@ts-ignore
        if (headers['x-ratelimit-global']) {
            bkt.ratelimiter.global = true;
            //@ts-ignore
            bkt.ratelimiter.globalReset = parseInt(headers['retry_after']);
        }
        //@ts-ignore
        if (headers['x-ratelimit-reset']) {
            //@ts-ignore
            let reset = (headers['x-ratelimit-reset'] * 1000) - offsetDate;
            if (reactions) {
                bkt.reset = Math.max(reset, 250);
            } else {
                bkt.reset = reset;
            }
        }
        //@ts-ignore
        if (headers['x-ratelimit-remaining']) {
            //@ts-ignore
            bkt.remaining = parseInt(headers['x-ratelimit-remaining']);
        } else {
            bkt.remaining = 1;
        }
        //@ts-ignore
        if (headers['x-ratelimit-limit']) {
            //@ts-ignore
            bkt.limit = parseInt(headers['x-ratelimit-limit']);
        }

    }

    /**
     * Execute a normal json request
     * @param {String} endpoint - Endpoint to use
     * @param {String} method - Http Method to use
     * @param {Object} data - Data to send
     * @param {Boolean} useParams - Whether to send the data in the body or use query params
     * @returns {Promise<Object>} - Result of the request
     * @private
     */
    async _request(endpoint: string, method: Method, data: Object, useParams = false): Promise<object> {
        let headers = {};
        //@ts-ignore
        if (data.reason) {
            //@ts-ignore
            headers['X-Audit-Log-Reason'] = data.reason;
            //@ts-ignore
            delete data.reason;
        }
        if (useParams) {
            return this.client({url: endpoint, method, params: data, headers});
        } else {
            return this.client({url: endpoint, method, data, headers});
        }
    }

    /**
     * Execute a multipart/form-data request
     * @param {String} endpoint - Endpoint to use
     * @param {String} method - Http Method to use
     * @param {Object} data - data to send
     * @param {Object} [data.file] - file to attach
     * @param {String} [data.file.name] - name of the file
     * @param {Buffer} [data.file.file] - Buffer with the file content
     * @returns {Promise.<Object>} - Result of the request
     * @private
     */
    async _multiPartRequest(endpoint: string, method: Method, data : {file?: {name?: string, file: Buffer}}): Promise<Object> {
        let formData = new FormData();
        if (data.file.file) {
            if (data.file.name) {
                formData.append('file', data.file.file, {filename: data.file.name});
            } else {
                formData.append('file', data.file.file);
            }

            delete data.file.file;
        }
        formData.append('payload_json', JSON.stringify(data));
        // :< axios is mean sometimes
        return this.client({
            url: endpoint,
            method,
            data: formData,
            //@ts-ignore
            headers: {'Content-Type': `multipart/form-data; boundary=${formData._boundary}`}
        });
    }
}

export default RequestHandler;