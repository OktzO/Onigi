import { EventEmitter } from 'events';
import { URL } from 'url';
export class AbstractSocketClient extends EventEmitter {
    constructor(url, config) {
        super();
        this.url = url;
        this.config = config;
        this.setMaxListeners(50);
    }
}
//# sourceMappingURL=types.js.map