# -*- coding: utf-8 -*-
from setuptools import setup, find_packages

with open('requirements.txt') as f:
	install_requires = f.read().strip().split('\n')

# get version from __version__ variable 
from ipconnex_ai_invoice import __version__ as version

setup(
	name='ipconnex_ai_invoice',
	version=version,
	description='A frappe module based on chat gpt to extract data from invoices',
	author='Frappe',
	author_email='voip@ipconnex.com',
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires
)