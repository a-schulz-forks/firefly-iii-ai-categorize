import express from "express";
import {getConfigVariable} from "./util.js";
import FireflyService from "./FireflyService.js";
import OpenAiService from "./OpenAiService.js";
import {Server} from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";
import {logger} from "./Logger.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    #firefly;
    #openAi;

    #server;
    #io;
    #express;

    #queue;
    #jobList;


    constructor() {
        this.#PORT = getConfigVariable("PORT", '3000');
        this.#ENABLE_UI = getConfigVariable("ENABLE_UI", 'false') === 'true';
    }

    async run() {
        this.#firefly = new FireflyService();
        this.#openAi = new OpenAiService();

        this.#queue = new Queue({
            timeout: 30 * 1000,
            concurrency: 1,
            autostart: true
        });

        this.#queue.addEventListener('start', job => logger.info('Job started', job))
        this.#queue.addEventListener('success', event => logger.info('Job success', event.job))
        this.#queue.addEventListener('error', event => logger.info('Job error', event.job, event.err))
        this.#queue.addEventListener('timeout', event => logger.info('Job timeout', event.job))

        this.#express = express();
        this.#server = http.createServer(this.#express)
        this.#io = new Server(this.#server)

        this.#jobList = new JobList();
        this.#jobList.on('job created', data => this.#io.emit('job created', data));
        this.#jobList.on('job updated', data => this.#io.emit('job updated', data));

        this.#express.use(express.json());

        if (this.#ENABLE_UI) {
            this.#express.use('/', express.static('public'))
        }

        this.#express.post('/webhook', this.#onWebhook.bind(this))

        this.#server.listen(this.#PORT, async () => {
            logger.info(`Application running on port ${this.#PORT}`);
        });

        this.#io.on('connection', socket => {
            logger.info('connected');
            socket.emit('jobs', Array.from(this.#jobList.getJobs().values()));
        })
    }

    #stringify(obj) {
        let cache = [];
        let str = JSON.stringify(obj, function (key, value) {
            if (typeof value === "object" && value !== null) {
                if (cache.indexOf(value) !== -1) {
                    // Circular reference found, discard key
                    return;
                }
                // Store value in our collection
                cache.push(value);
            }
            return value;
        });
        cache = null; // reset the cache
        return str;
    }

    #onWebhook(req, res) {
        try {
            logger.info("Webhook triggered");
            // logger.info(this.#stringify(req))
            this.#handleWebhook(req, res);
            res.send("Queued");
        } catch (e) {
            logger.error(e)
            res.status(400).send(e.message);
        }
    }

    #handleWebhook(req, res) {
        // TODO: validate auth

        if (req.body?.trigger !== "STORE_TRANSACTION") {
            throw new WebhookException("trigger is not STORE_TRANSACTION. Request will not be processed");
        }

        if (req.body?.response !== "TRANSACTIONS") {
            throw new WebhookException("trigger is not TRANSACTION. Request will not be processed");
        }

        if (!req.body?.content?.id) {
            throw new WebhookException("Missing content.id");
        }

        if (req.body?.content?.transactions?.length === 0) {
            throw new WebhookException("No transactions are available in content.transactions");
        }

        if (req.body.content.transactions[0].type !== "withdrawal") {
            throw new WebhookException("content.transactions[0].type has to be 'withdrawal'. Transaction will be ignored.");
        }

        if (req.body.content.transactions[0].category_id !== null) {
            throw new WebhookException("content.transactions[0].category_id is already set. Transaction will be ignored.");
        }

        if (!req.body.content.transactions[0].description) {
            throw new WebhookException("Missing content.transactions[0].description");
        }

        if (!req.body.content.transactions[0].destination_name) {
            throw new WebhookException("Missing content.transactions[0].destination_name");
        }

        const destinationName = req.body.content.transactions[0].destination_name;
        const description = req.body.content.transactions[0].description

        const job = this.#jobList.createJob({
            destinationName,
            description
        });

        this.#queue.push(async () => {
            logger.info("Pushed to queue")
            this.#jobList.setJobInProgress(job.id);

            const categories = await this.#firefly.getCategories();
            logger.info("Categories fetched" + categories.values())

            const {
                category,
                prompt,
                response
            } = await this.#openAi.classify(Array.from(categories.keys()), destinationName, description)

            const newData = Object.assign({}, job.data);
            newData.category = category;
            newData.prompt = prompt;
            newData.response = response;

            this.#jobList.updateJobData(job.id, newData);

            if (category) {
                await this.#firefly.setCategory(req.body.content.id, req.body.content.transactions, categories.get(category));
            }

            this.#jobList.setJobFinished(job.id);
        });
    }
}

class WebhookException extends Error {

    constructor(message) {
        super(message);
    }
}