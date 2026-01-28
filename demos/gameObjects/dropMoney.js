import { Drop, DROP_TYPES } from "./drop.js";
import { DropComponent } from "../components/dropComponent.js";

export class DropMoney extends Drop {

    static scriptUrl = import.meta.url;

    static components = [
        ...Drop.components,
        DropComponent
    ];

    onSpawned(config) {
        super.onSpawned(config);

        this.dropComponent.type = DROP_TYPES.MONEY;
        this.dropComponent.amount = config.amount || 100;

        this.setScale(0.2, 0.2)
        this.setSprite("money");

    }

}
