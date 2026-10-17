/*global QUnit*/
import Controller from "retrobillingapp/controller/retrobillingapp.controller";

QUnit.module("retrobillingapp Controller");

QUnit.test("I should test the retrobillingapp controller", function (assert: Assert) {
	const oAppController = new Controller("retrobillingapp");
	oAppController.onInit();
	assert.ok(oAppController);
});